import { createHash } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { PgBoss, WorkOptions } from "pg-boss";

import {
  AiRepository,
  createAiSecretCipher,
  HttpApiAdapter,
  parseAiApiKeyCredential
} from "@moss/ai";
import type { AiSecretCipher, GenerateChatInput, ProviderKind } from "@moss/ai";
import type { DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";
import {
  createMemoryCandidateSignature,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  MemoryRepository,
  type EmbeddingProvider,
  type MemoryCandidateRecord,
  type MemoryRecordKind,
  type NewChunkData
} from "@moss/memory";
import {
  registerDataContextWorker,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";
import {
  NOTES_SYNC_QUEUE,
  writeDailyChatArchive,
  type ChatArchiveMessage,
  type ChatArchiveSession,
  type NotesSyncJobPayload,
  type NotesSyncToolService
} from "@moss/notes";
import {
  CHAT_ARCHIVE_DEFAULT_FOLDER,
  CHAT_ARCHIVE_ENABLED_PREF_KEY,
  CHAT_ARCHIVE_ENABLED_SINCE_PREF_KEY,
  CHAT_ARCHIVE_FOLDER_PREF_KEY
} from "@moss/settings";
import { localDay } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { extractTimezone } from "./locale-utils.js";
import { ChatRepository } from "./repository.js";
import {
  buildDistillationPrompt,
  containsSensitiveMemoryText,
  decideCandidatePromotion,
  memoryCandidateContainsSensitiveText,
  parseMemoryCandidates,
  rawTurnContainsSensitiveText,
  shouldDistillTurn,
  type MemoryCandidate
} from "./memory-distillation.js";

// ── Queue names ───────────────────────────────────────────────────────────────

export const CHAT_EMBED_TURN_QUEUE = "chat.embed-turn";
export const CHAT_EXTRACT_FACTS_QUEUE = "chat.extract-facts";
export const CHAT_ARCHIVE_DAY_QUEUE = "chat.archive-day";

export const CHAT_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  { name: CHAT_EMBED_TURN_QUEUE, options: { retryLimit: 2, deleteAfterSeconds: 600 } },
  { name: CHAT_EXTRACT_FACTS_QUEUE, options: { retryLimit: 2, deleteAfterSeconds: 600 } },
  { name: CHAT_ARCHIVE_DAY_QUEUE, options: { retryLimit: 2, deleteAfterSeconds: 600 } }
];

// ── Payloads ──────────────────────────────────────────────────────────────────

export interface EmbedTurnJobPayload extends ActorScopedJobPayload {
  readonly threadId: string;
  readonly messageId: string;
}

export interface ExtractFactsJobPayload extends ActorScopedJobPayload {
  readonly threadId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
}

export interface ArchiveDayJobPayload extends ActorScopedJobPayload {
  readonly localDate: string;
}

// ── Embed-turn handler ────────────────────────────────────────────────────────

/**
 * Embed the most recent user+assistant turn-pair for a thread into memory_chunks
 * with source_kind='chat'. Idempotent via content hash.
 */
async function handleEmbedTurnJob(
  scopedDb: DataContextDb,
  ownerUserId: string,
  threadId: string,
  embeddingProvider: EmbeddingProvider,
  memoryRepository: MemoryRepository,
  chatRepository: ChatRepository = new ChatRepository()
): Promise<void> {
  const messages = await chatRepository.listMessages(scopedDb, threadId);
  const stored = messages.filter((m) => m.status === "stored");
  const lastTwo = stored.slice(-2);
  if (lastTwo.length < 2) return;

  const userMsg = lastTwo.find((m) => m.role === "user");
  const assistantMsg = lastTwo.find((m) => m.role === "assistant");
  if (!userMsg || !assistantMsg) return;

  const text = `User: ${userMsg.body}\nAssistant: ${assistantMsg.body}`;
  const contentHash = createHash("sha256").update(text).digest("hex");

  const existing = await memoryRepository.getFileIndex(scopedDb, ownerUserId, "chat", threadId);
  if (existing?.fileHash === contentHash) return;

  const embedding = await embeddingProvider.embedDocument(text);
  const chunk: NewChunkData = {
    sourcePath: threadId,
    lineStart: 0,
    lineEnd: 0,
    contentHash,
    text,
    embedding
  };

  await memoryRepository.upsertFileChunks(
    scopedDb,
    ownerUserId,
    threadId,
    [chunk],
    embeddingProvider.modelName,
    embeddingProvider.modelVersion,
    "chat"
  );

  await memoryRepository.upsertFileIndex(
    scopedDb,
    ownerUserId,
    "chat",
    threadId,
    contentHash,
    1,
    embeddingProvider.modelName,
    embeddingProvider.modelVersion
  );
}

// ── Memory distillation handler ───────────────────────────────────────────────

const MAX_CANDIDATES_PER_TURN = 8;
// Economy output budget for the extraction call — bounds cost on a side-effect job
// that must never dominate a chat turn's spend (clamped by the adapter, see A5b).
const EXTRACT_MAX_OUTPUT_TOKENS = 512;

export interface ExtractFactsDeps {
  readonly aiRepository: AiRepository;
  readonly cipher: AiSecretCipher;
  readonly candidatesRepository?: MemoryCandidatesRepository;
  readonly graphRepository?: MemoryGraphRepository;
  /**
   * Structured logger for extraction-failure observability
   * (chat_extract_facts_failed). Optional; production injects a module logger
   * (observability spec: no console.* in prod).
   */
  readonly logger?: Pick<FastifyBaseLogger, "error">;
  // Use the real GenerateChatInput so `maxOutputTokens` typechecks (no excess-property error).
  readonly createAdapter?: (
    kind: ProviderKind,
    apiKey: string,
    baseUrl: string | null
  ) => { generateChat: (input: GenerateChatInput) => Promise<{ readonly text: string }> };
}

/**
 * Chat memory distillation worker. Captures a bounded source episode for the exact
 * queued turn, gates noise deterministically, stores candidates, and promotes only
 * low-risk volunteered memories through the memory graph repository. Payload/logs
 * stay metadata-only; extraction failures never block chat completion.
 */
export async function handleExtractFactsJob(
  scopedDb: DataContextDb,
  ownerUserId: string,
  payload: ExtractFactsJobPayload,
  deps: ExtractFactsDeps,
  chatRepository: ChatRepository = new ChatRepository()
): Promise<void> {
  const graphRepository = deps.graphRepository ?? new MemoryGraphRepository();
  const candidatesRepository = deps.candidatesRepository ?? new MemoryCandidatesRepository();
  try {
    const thread = await chatRepository.getThreadById(scopedDb, payload.threadId);
    const messages = await chatRepository.listMessages(scopedDb, payload.threadId);
    const userMsg = messages.find(
      (m) => m.id === payload.userMessageId && m.role === "user" && m.status === "stored"
    );
    const assistantMsg = messages.find(
      (m) => m.id === payload.assistantMessageId && m.role === "assistant" && m.status === "stored"
    );
    if (!userMsg || !assistantMsg) return;

    if (rawTurnContainsSensitiveText(userMsg.body, assistantMsg.body)) return;

    const threadTitle = safeThreadTitle(thread?.title ?? "");
    const excerpt = boundedTurnExcerpt(userMsg.body, assistantMsg.body);
    const episode = await graphRepository.createEpisode(scopedDb, ownerUserId, {
      sourceKind: "chat",
      sourceRef: payload.threadId,
      sourceLabel: threadTitle,
      occurredAt: assistantMsg.created_at,
      excerpt
    });

    if (!shouldDistillTurn(userMsg.body, assistantMsg.body)) return;

    const model = await deps.aiRepository.selectModelForCapability(
      scopedDb,
      "summarization",
      "economy"
    );
    if (!model) return;

    const provider = await deps.aiRepository.selectProviderWithCredential(
      scopedDb,
      model.provider_config_id
    );
    if (!provider?.encrypted_credential) return;
    const credential = parseAiApiKeyCredential(
      deps.cipher.decryptJson(provider.encrypted_credential)
    );
    if (!credential) return;

    const activeMemory = (await graphRepository.listCoreFacts(scopedDb, ownerUserId, 30)).map(
      (fact) => ({
        id: fact.id,
        text: [fact.predicate, fact.objectText ?? fact.objectEntityId ?? ""].join(" ").trim()
      })
    );
    const prompt = buildDistillationPrompt({
      userText: userMsg.body,
      assistantText: assistantMsg.body,
      threadTitle,
      activeMemory
    });

    const adapter = (
      deps.createAdapter ??
      ((k, key, base) => new HttpApiAdapter(k, key, base ? { baseUrl: base } : {}))
    )(model.provider_kind as ProviderKind, credential.apiKey, provider.base_url);
    const { text } = await adapter.generateChat({
      model: { provider_kind: model.provider_kind, provider_model_id: model.provider_model_id },
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS
    });

    for (const candidate of parseMemoryCandidates(text).slice(0, MAX_CANDIDATES_PER_TURN)) {
      if (candidate.isSensitive || memoryCandidateContainsSensitiveText(candidate)) continue;
      const record = await candidatesRepository.insertPending(scopedDb, ownerUserId, {
        episodeId: episode.id,
        kind: candidate.kind,
        action: candidate.action,
        payloadJson: candidate,
        candidateSignature: createSignature(candidate),
        confidence: candidate.confidence,
        importance: candidate.importance,
        provenance: candidate.provenance
      });
      if (record.status !== "pending") continue;
      await maybePromoteCandidate(
        scopedDb,
        ownerUserId,
        record,
        candidate,
        graphRepository,
        candidatesRepository,
        episode.id,
        hasExplicitMemoryCommand(userMsg.body),
        hasExplicitCorrection(userMsg.body)
      );
    }
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    deps.logger?.error(
      {
        event: "chat_extract_facts_failed",
        threadId: payload.threadId,
        error: e.name,
        message: e.message.slice(0, 200)
      },
      "chat fact extraction failed"
    );
    // No-op degrade: never throw — a flaky extraction must not block the chat turn.
  }
}

// ── Archive-day handler ───────────────────────────────────────────────────────

/**
 * Generous UTC window around a local calendar date (`YYYY-MM-DD`) that is
 * guaranteed to contain every instant that could fall on that date in any IANA
 * timezone (offsets run from UTC-12 to UTC+14). The caller filters the returned
 * rows precisely with `localDay`; this window only bounds the database query.
 */
function utcRangeForLocalDate(localDate: string): {
  rangeStartUtcIso: string;
  rangeEndUtcIso: string;
} {
  const localMidnightUtc = new Date(`${localDate}T00:00:00.000Z`).getTime();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  return {
    rangeStartUtcIso: new Date(localMidnightUtc - 24 * ONE_HOUR_MS).toISOString(),
    rangeEndUtcIso: new Date(localMidnightUtc + 48 * ONE_HOUR_MS).toISOString()
  };
}

export async function handleArchiveDayJob(
  scopedDb: DataContextDb,
  actorUserId: string,
  localDate: string,
  deps: { preferencesPort: PreferencesPort; chatRepo: ChatRepository; boss: PgBoss }
): Promise<void> {
  const enabled = await deps.preferencesPort.get(scopedDb, CHAT_ARCHIVE_ENABLED_PREF_KEY);
  if (enabled !== true) return;

  const folderRaw = await deps.preferencesPort.get(scopedDb, CHAT_ARCHIVE_FOLDER_PREF_KEY);
  const folder =
    typeof folderRaw === "string" && folderRaw.length > 0 ? folderRaw : CHAT_ARCHIVE_DEFAULT_FOLDER;

  const enabledSinceRaw = await deps.preferencesPort.get(
    scopedDb,
    CHAT_ARCHIVE_ENABLED_SINCE_PREF_KEY
  );
  const enabledSinceMs =
    typeof enabledSinceRaw === "string" && !Number.isNaN(Date.parse(enabledSinceRaw))
      ? Date.parse(enabledSinceRaw)
      : null;

  const localeRaw = await deps.preferencesPort.get(scopedDb, "locale");
  const timezone = extractTimezone(localeRaw) ?? "UTC";

  const { rangeStartUtcIso, rangeEndUtcIso } = utcRangeForLocalDate(localDate);
  const rows = await deps.chatRepo.listStoredMessagesInRange(
    scopedDb,
    actorUserId,
    rangeStartUtcIso,
    rangeEndUtcIso
  );
  const sameDay = rows
    .filter((row) => localDay(row.createdAt, timezone) === localDate)
    .filter(
      (row) => enabledSinceMs === null || new Date(row.createdAt).getTime() >= enabledSinceMs
    );
  if (sameDay.length === 0) return;

  const sessionsByThread = new Map<
    string,
    { threadTitle: string; threadFirstMessageAt: string; messages: ChatArchiveMessage[] }
  >();
  for (const row of sameDay) {
    let session = sessionsByThread.get(row.threadId);
    if (!session) {
      session = {
        threadTitle: row.threadTitle,
        threadFirstMessageAt: row.threadFirstMessageAt,
        messages: []
      };
      sessionsByThread.set(row.threadId, session);
    }
    session.messages.push({ role: row.role, body: row.body, createdAt: row.createdAt });
  }
  const sessions: ChatArchiveSession[] = [...sessionsByThread.entries()]
    .sort(([, a], [, b]) => a.threadFirstMessageAt.localeCompare(b.threadFirstMessageAt))
    .map(([threadId, session]) => ({
      threadId,
      title: session.threadTitle,
      messages: session.messages
    }));

  const notesSync: NotesSyncToolService = {
    enqueue: (enqueueActorUserId, sourcePath) => {
      const payload: NotesSyncJobPayload = { actorUserId: enqueueActorUserId, sourcePath };
      return sendJob(deps.boss, NOTES_SYNC_QUEUE, payload, {
        singletonKey: `notes-sync:${enqueueActorUserId}`
      });
    }
  };

  await writeDailyChatArchive(
    scopedDb,
    actorUserId,
    localDate,
    folder,
    sessions,
    timezone,
    notesSync
  );
}

// ── Worker registration ───────────────────────────────────────────────────────

export interface RegisterChatJobWorkersOptions {
  readonly embeddingProviderFactory: (scopedDb: DataContextDb) => Promise<EmbeddingProvider>;
  /**
   * AI deps for the extract-facts worker. Optional here so the module registry can
   * land its injection in a follow-up (A13) without breaking this signature; when
   * absent we build the real deps in-process (capability router + cipher + facts repo),
   * mirroring the briefings worker's `composeDeps` default.
   */
  readonly extractFactsDeps?: ExtractFactsDeps;
  /**
   * Preferences accessor for the archive-day worker (reads `chat-archive.enabled`,
   * `chat-archive.folder`, and `locale`). Defaults to a real PreferencesRepository —
   * same key-agnostic port `localePreferences` already uses on the route side.
   */
  readonly preferencesPort?: PreferencesPort;
  readonly workOptions?: WorkOptions;
  /**
   * Structured logger for worker-path diagnostics (chat_extract_facts_failed).
   * Optional for back-compat; production injects a module-tagged child of the
   * worker logger (observability spec: no console.* in prod).
   */
  readonly logger?: FastifyBaseLogger;
}

function defaultExtractFactsDeps(): ExtractFactsDeps {
  return {
    aiRepository: new AiRepository(),
    cipher: createAiSecretCipher(),
    candidatesRepository: new MemoryCandidatesRepository(),
    graphRepository: new MemoryGraphRepository()
  };
}

export async function registerChatJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  options: RegisterChatJobWorkersOptions
): Promise<string[]> {
  const memoryRepo = new MemoryRepository();
  const chatRepo = new ChatRepository();
  const preferencesPort = options.preferencesPort ?? new PreferencesRepository();
  const extractFactsDeps = options.extractFactsDeps ?? defaultExtractFactsDeps();
  // Thread the worker logger into the extract-facts deps if the caller did not
  // supply its own extractFactsDeps with a logger (observability spec).
  if (!options.extractFactsDeps && options.logger) {
    (extractFactsDeps as { logger?: Pick<FastifyBaseLogger, "error"> }).logger = options.logger;
  }

  const embedWorkId = await registerDataContextWorker<EmbedTurnJobPayload, void>(
    boss,
    CHAT_EMBED_TURN_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      const embeddingProvider = await options.embeddingProviderFactory(scopedDb);
      await handleEmbedTurnJob(
        scopedDb,
        job.data.actorUserId,
        job.data.threadId,
        embeddingProvider,
        memoryRepo,
        chatRepo
      );
    },
    options.workOptions
  );

  const extractWorkId = await registerDataContextWorker<ExtractFactsJobPayload, void>(
    boss,
    CHAT_EXTRACT_FACTS_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      await handleExtractFactsJob(
        scopedDb,
        job.data.actorUserId,
        job.data,
        extractFactsDeps,
        chatRepo
      );
    },
    options.workOptions
  );

  const archiveWorkId = await registerDataContextWorker<ArchiveDayJobPayload, void>(
    boss,
    CHAT_ARCHIVE_DAY_QUEUE,
    dataContext,
    (job, scopedDb) =>
      handleArchiveDayJob(scopedDb, job.data.actorUserId, job.data.localDate, {
        preferencesPort,
        chatRepo,
        boss
      }),
    options.workOptions
  );

  return [embedWorkId, extractWorkId, archiveWorkId];
}

async function maybePromoteCandidate(
  scopedDb: DataContextDb,
  ownerUserId: string,
  record: MemoryCandidateRecord,
  candidate: MemoryCandidate,
  graphRepository: MemoryGraphRepository,
  candidatesRepository: MemoryCandidatesRepository,
  episodeId: string,
  explicitMemoryCommand: boolean,
  explicitCorrection: boolean
): Promise<void> {
  const allowsSupersession =
    explicitCorrection && candidate.kind === "supersession" && candidate.action === "supersede";
  const groundedFact = allowsSupersession
    ? await firstGroundedFact(scopedDb, ownerUserId, graphRepository, candidate.supersedesIds ?? [])
    : undefined;
  const decision = decideCandidatePromotion({
    candidate,
    explicitMemoryCommand,
    explicitCorrection,
    conflicts: false,
    groundedSupersedes: Boolean(groundedFact)
  });
  if (decision.status !== "promote") return;

  if (allowsSupersession && groundedFact) {
    await graphRepository.supersedeFact(scopedDb, ownerUserId, groundedFact.id);
  }

  if (candidate.kind === "entity" && candidate.entity) {
    await graphRepository.createEntity(scopedDb, ownerUserId, {
      kind: candidate.entity.kind,
      name: candidate.entity.name,
      summary: candidate.entity.summary,
      importance: candidate.importance
    });
    await candidatesRepository.markPromoted(scopedDb, ownerUserId, record.id, decision.reason);
    return;
  }

  if (candidate.fact) {
    const self = await graphRepository.ensureSelfEntity(scopedDb, ownerUserId);
    await graphRepository.createFactFromEpisode(scopedDb, ownerUserId, {
      episodeId,
      subjectEntityId: self.id,
      predicate: candidate.fact.predicate,
      objectText: candidate.fact.objectText ?? candidate.fact.objectName,
      recordKind: recordKindForCandidate(candidate),
      confidence: candidate.confidence,
      provenance: candidate.provenance,
      importance: candidate.importance
    });
    await candidatesRepository.markPromoted(scopedDb, ownerUserId, record.id, decision.reason);
  }
}

function recordKindForCandidate(candidate: MemoryCandidate): MemoryRecordKind {
  if (candidate.kind === "alias") return "alias";
  switch (candidate.fact?.predicate) {
    case "prefers":
      return "preference";
    case "has_goal":
      return "goal";
    case "has_constraint":
      return "constraint";
    case "decided":
      return "decision";
    case "alias_of":
      return "alias";
    case "related_to":
      return "relationship";
    default:
      return candidate.provenance === "inferred" ? "inference" : "fact";
  }
}

async function firstGroundedFact(
  scopedDb: DataContextDb,
  ownerUserId: string,
  graphRepository: MemoryGraphRepository,
  ids: readonly string[]
) {
  for (const id of ids) {
    const fact = await graphRepository.getActiveFact(scopedDb, ownerUserId, id);
    if (fact) return fact;
  }
  return undefined;
}

function createSignature(candidate: MemoryCandidate): string {
  return createMemoryCandidateSignature({
    kind: candidate.kind,
    action: candidate.action,
    entity: candidate.entity ? { name: candidate.entity.name } : undefined,
    fact: candidate.fact,
    alias: candidate.alias
  });
}

function hasExplicitMemoryCommand(userText: string): boolean {
  return /\b(remember|don't forget|note that|save this)\b/i.test(userText);
}

function hasExplicitCorrection(userText: string): boolean {
  return /\b(actually|correction|correcting|that's wrong|that is wrong|instead|rather than)\b|(^|\W)no,\s|not\s+[^.?!\n]{1,80}\b(?:but|use|prefer|go with)\b/i.test(
    userText
  );
}

function safeThreadTitle(title: string): string {
  return containsSensitiveMemoryText(title) ? "[redacted]" : title;
}

function boundedTurnExcerpt(userText: string, assistantText: string): string {
  const text = `User: ${userText}\nAssistant: ${assistantText}`;
  return text.length > 2000 ? text.slice(0, 2000) : text;
}
