/**
 * DataContextChatPersistence — the REAL ChatPersistencePort backing the live
 * ChatSessionManager.
 *
 * Every method builds an AccessContext { actorUserId, requestId } and runs its
 * queries through the DataContextRunner so RLS scopes all reads/writes to the
 * acting owner. Provider routing reuses the AI capability router; turn recording
 * reuses ChatRepository's recency + completed-turn helpers and then enqueues the
 * episodic-embed job (unless the thread is incognito).
 */
import type { AiConfiguredModelSafeRow, AiRepository, ProviderKind } from "@moss/ai";
import { extractTimezone, resolveEffectiveTimezone } from "../locale-utils.js";
import { sql, type Kysely } from "kysely";
import {
  assertDataContextDb,
  type ChatThread,
  type DataContextDb,
  type DataContextRunner,
  type MossDatabase,
  type PreferencesPort
} from "@moss/db";
import { CHAT_SETTINGS_PREFERENCE_KEY, normalizeChatSettings } from "@moss/shared";
import type {
  AnswerProvenanceMetadataV1,
  AiAuthMethod,
  ChatAttachmentDto,
  ChatSurface,
  ChatTurnOriginV1,
  ChatTurnUsageDto,
  SourceFreshnessEntry,
  SourceFreshnessV1
} from "@moss/shared";
import { localDay } from "@moss/shared";
import { CHAT_ARCHIVE_ENABLED_PREF_KEY } from "@moss/settings";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";
import type { PgBoss } from "pg-boss";

import { sendJob } from "@moss/jobs";

import {
  CHAT_ARCHIVE_DAY_QUEUE,
  CHAT_EMBED_TURN_QUEUE,
  CHAT_EXTRACT_FACTS_QUEUE,
  CHAT_SUMMARIZE_CONVERSATION_QUEUE,
  type ArchiveDayJobPayload,
  type SummarizeConversationJobPayload,
  type EmbedTurnJobPayload,
  type ExtractFactsJobPayload
} from "../jobs.js";
import { containsSensitiveMemoryText } from "../memory-distillation.js";
import type { ChatPersistencePort } from "./chat-session-manager.js";
import type { HandledTurnOptions } from "./chat-session-ports.js";
import type { ChatRepository } from "../repository.js";
import { normalizeChatSurface } from "./chat-surface.js";
import { terminalActionRecord } from "../action-record-history.js";
import { estimateTokens } from "./recall-seed.js";
import { UnsupportedLegacyCliProviderError } from "./errors.js";
import { getReplayK, getReplayTokenCap, type ReplayMessage } from "./replay-window.js";

export { getReplayK, getReplayTokenCap } from "./replay-window.js";
import {
  SUMMARY_RUN_INPUT_TOKENS,
  planSummaryCoverage,
  splitAtSummaryFrontier,
  storedCoverageTurns,
  type CoverageTurn
} from "./summary-coverage.js";

/** Provider-kinds the live CLI runtime can drive (the narrow ProviderKind set). */
const LIVE_PROVIDER_KINDS: readonly ProviderKind[] = ["anthropic", "openai-compatible", "google"];

/** Title used when the live runtime has to open a user's first conversation. */
const DEFAULT_CONVERSATION_TITLE = "Conversation";

export interface DataContextChatPersistenceDeps {
  readonly rootDb?: Kysely<MossDatabase>;
  readonly dataContext: DataContextRunner;
  readonly chatRepository: ChatRepository;
  readonly aiRepository: AiRepository;
  readonly boss?: PgBoss;
  readonly connectorSyncAt?: (
    scopedDb: DataContextDb,
    kind: "email" | "calendar"
  ) => Promise<Date | null>;
  /** Used to read the user's IANA timezone from their locale preference (key "locale"). */
  readonly localePreferences?: PreferencesPort;
  /** Reads the user's saved ACP model choice for the live launch. */
  readonly chatPreferences?: PreferencesPort;
}

/**
 * Superset of both completed-turn option shapes. A model turn fills invokedToolNames/usage etc;
 * a gate-handled turn supplies a precomputed sourceFreshness and its action/activity records.
 */
interface PersistTurnOptions {
  readonly threadId?: string | null;
  readonly invokedToolNames?: ReadonlySet<string>;
  readonly answerProvenance?: AnswerProvenanceMetadataV1;
  readonly attachments?: readonly ChatAttachmentDto[];
  readonly actionResults?: readonly ActionResultMetadata[];
  readonly activityRecords?: readonly TranscriptRecord[];
  readonly elapsedMs?: number;
  readonly usage?: ChatTurnUsageDto;
  readonly sourceFreshness?: SourceFreshnessV1 | null;
}

export function toolNameToSource(toolName: string): string | null {
  if (toolName.startsWith("email.")) return "email";
  if (toolName.startsWith("calendar.")) return "calendar";
  if (toolName.startsWith("vault.") || toolName.startsWith("notes.")) return "vault";
  if (toolName.startsWith("tasks.")) return "tasks";
  if (toolName.startsWith("commitments.")) return "commitments";
  if (toolName.startsWith("chat.")) return "chats";
  if (toolName.startsWith("goals.")) return "goals";
  return null;
}

const CONNECTOR_SOURCES_CHAT = new Set(["email", "calendar"]);
const REALTIME_SOURCES_CHAT = new Set(["tasks", "commitments", "chats", "goals"]);

export async function resolveChatFreshness(
  scopedDb: DataContextDb,
  invokedToolNames: ReadonlySet<string>,
  capturedAt: Date,
  opts: {
    connectorSyncAt?: (scopedDb: DataContextDb, kind: "email" | "calendar") => Promise<Date | null>;
  }
): Promise<SourceFreshnessV1 | null> {
  const sourceKeys = new Set<string>();
  for (const name of invokedToolNames) {
    const source = toolNameToSource(name);
    if (source) sourceKeys.add(source);
  }
  if (sourceKeys.size === 0) return null;

  const capturedAtIso = capturedAt.toISOString();
  const entries: SourceFreshnessEntry[] = [];
  for (const source of sourceKeys) {
    if (REALTIME_SOURCES_CHAT.has(source)) {
      entries.push({ source, freshnessKind: "realtime", asOf: capturedAtIso });
    } else if (CONNECTOR_SOURCES_CHAT.has(source)) {
      let asOf: string | null = null;
      try {
        const t = (await opts.connectorSyncAt?.(scopedDb, source as "email" | "calendar")) ?? null;
        asOf = t ? t.toISOString() : null;
      } catch {
        // keep asOf as null on error
      }
      entries.push({ source, freshnessKind: "connector_sync", asOf });
    } else {
      // vault — V1: asOf: null (no vaultLastWriteAt dep for chat)
      entries.push({ source, freshnessKind: "vault_write", asOf: null });
    }
  }

  return { version: 1, capturedAt: capturedAtIso, sources: entries };
}

export class DataContextChatPersistence implements ChatPersistencePort {
  private readonly dataContext: DataContextRunner;
  private readonly rootDb: Kysely<MossDatabase> | undefined;
  private readonly chat: ChatRepository;
  private readonly ai: AiRepository;
  private readonly boss: PgBoss | undefined;
  private readonly connectorSyncAt: DataContextChatPersistenceDeps["connectorSyncAt"];
  private readonly localePreferences: PreferencesPort | undefined;
  private readonly chatPreferences: PreferencesPort | undefined;

  constructor(deps: DataContextChatPersistenceDeps) {
    this.rootDb = deps.rootDb;
    this.dataContext = deps.dataContext;
    this.chat = deps.chatRepository;
    this.ai = deps.aiRepository;
    this.boss = deps.boss;
    this.connectorSyncAt = deps.connectorSyncAt;
    this.localePreferences = deps.localePreferences;
    this.chatPreferences = deps.chatPreferences;
  }

  async resolveActiveProvider(actorUserId: string): Promise<{
    provider: ProviderKind;
    model: string;
    providerConfigId: string;
    authMethod: AiAuthMethod;
    acpAgentId: string | null;
    acpModel?: string;
  }> {
    const { model, openCodeModel } = await this.run(
      actorUserId,
      "resolve-provider",
      async (scopedDb) => {
        // Sequential: model selection can write through a savepoint.
        const model = await this.ai.selectChatModelForUser(scopedDb);
        const rawChatSettings = await this.chatPreferences?.get(
          scopedDb,
          CHAT_SETTINGS_PREFERENCE_KEY
        );
        return { model, openCodeModel: normalizeChatSettings(rawChatSettings).openCodeModel };
      }
    );

    if (!model) {
      throw new Error("No active chat-capable model is configured for this user.");
    }

    const provider = toLiveProvider(model);
    return {
      provider,
      model: model.provider_model_id,
      providerConfigId: model.provider_config_id,
      authMethod: model.provider_auth_method,
      acpAgentId: model.provider_acp_agent_id,
      ...(model.provider_acp_agent_id === "opencode" && openCodeModel
        ? { acpModel: openCodeModel }
        : {})
    };
  }

  async listPriorTurns(
    actorUserId: string,
    opts?: { readonly forceReplay?: boolean; readonly threadId?: string | null },
    surface?: ChatSurface
  ): Promise<{
    recent: readonly ReplayMessage[];
    oldSummary: string | null;
  }> {
    const threadId = opts?.threadId;
    if (threadId === null) return { recent: [], oldSummary: null };
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "list-prior-turns", async (scopedDb) => {
      // Launch replay follows the captured token binding even if another conversation
      // becomes current during earlier awaits. Explicitly missing bindings replay nothing.
      const thread =
        threadId === undefined
          ? await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface)
          : await this.chat.getThreadById(scopedDb, threadId, chatSurface);
      if (!thread || thread.owner_user_id !== actorUserId || thread.surface !== chatSurface) {
        return { recent: [], oldSummary: null };
      }

      // D4: incognito replays nothing, enforced here regardless of caller. No
      // further window/summary work runs for an incognito thread.
      if (thread.incognito) {
        return { recent: [], oldSummary: null };
      }

      const messages = await this.chat.listMessages(scopedDb, thread.id);
      const turns = storedCoverageTurns(messages);

      // Replay is the accepted summary plus every turn after its frontier, untruncated.
      // The launch refuses a replay that overflows its budget instead of dropping turns.
      const split = splitAtSummaryFrontier(turns, {
        summary: thread.conversation_summary,
        coveredThroughMessageId: thread.summary_covered_through_message_id,
        revision: thread.summary_revision
      });
      const recent: ReplayMessage[] = split.uncovered.map((m) => ({
        role: m.role,
        content: m.content
      }));
      const oldSummary = split.summary;

      // D8: visibility only — counts and trigger, never message/summary content.
      // "switch" is a valid trigger value but unreachable in Phase 1: switchProvider
      // and healAndRelaunch both set forceReplay:true identically, with no signal
      // that would let this seam tell a provider switch apart from a relaunch.
      const trigger: "launch" | "relaunch" | "switch" = opts?.forceReplay ? "relaunch" : "launch";
      console.info(
        JSON.stringify({
          event: "chat.replay.injected",
          threadId: thread.id,
          messageCount: recent.length,
          tokenCount: recent.reduce((sum, m) => sum + estimateTokens(`${m.role}: ${m.content}`), 0),
          summaryTokens: oldSummary ? estimateTokens(oldSummary) : 0,
          trigger
        })
      );

      return { recent, oldSummary };
    });
  }

  async recordTurn(
    actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: {
      readonly threadId?: string | null;
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly answerProvenance?: AnswerProvenanceMetadataV1;
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
      readonly activityRecords?: readonly TranscriptRecord[];
      readonly elapsedMs?: number;
      readonly usage?: ChatTurnUsageDto;
    },
    surface?: ChatSurface
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string } | undefined> {
    return this.persistCompletedTurn(
      actorUserId,
      "record-turn",
      userText,
      assistantReply,
      opts,
      surface,
      { executed }
    );
  }

  /**
   * Task 4.1 (#2901) — persist a completed turn the classifier gate handled. Same thread/title/
   * summary/background-job post-processing as a model turn, but the assistant message carries the
   * gate-origin contract instead of an executed provider/model or usage (recording either would be
   * fiction: no model ran).
   */
  async recordHandledTurn(
    actorUserId: string,
    userText: string,
    assistantReply: string,
    origin: ChatTurnOriginV1,
    opts?: HandledTurnOptions,
    surface?: ChatSurface
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly sourceFreshness?: SourceFreshnessV1 | null;
      }
    | undefined
  > {
    return this.persistCompletedTurn(
      actorUserId,
      "record-handled-turn",
      userText,
      assistantReply,
      opts,
      surface,
      { origin }
    );
  }

  /**
   * The one completed-turn pipeline shared by model turns and gate-handled turns. `turn` is a
   * discriminated union: either the executing provider/model or the gate origin, never both, so a
   * handled turn can never accidentally write a fabricated `executed` or `usage`.
   */
  private async persistCompletedTurn(
    actorUserId: string,
    operation: string,
    userText: string,
    assistantReply: string,
    opts: PersistTurnOptions | undefined,
    surface: ChatSurface | undefined,
    turn:
      | { readonly executed: { provider: ProviderKind; model: string } }
      | { readonly origin: ChatTurnOriginV1 }
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly sourceFreshness?: SourceFreshnessV1 | null;
      }
    | undefined
  > {
    const threadId = opts?.threadId;
    if (threadId === null) return undefined;
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, operation, async (scopedDb) => {
      const thread =
        threadId === undefined
          ? ((await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface)) ??
            (await this.chat.openNewThread(scopedDb, {
              title: DEFAULT_CONVERSATION_TITLE,
              surface: chatSurface
            })))
          : await this.chat.getThreadById(scopedDb, threadId, chatSurface);
      if (!thread || thread.owner_user_id !== actorUserId || thread.surface !== chatSurface) {
        return undefined;
      }

      // Hold the owner/surface selection lock before message or summary writes. A late
      // bound completion saves its original thread without selecting it over a resume.
      if (threadId === undefined) {
        await this.chat.touchThread(scopedDb, thread.id, chatSurface);
      } else {
        await this.chat.touchCurrentThread(scopedDb, thread.id, chatSurface);
      }

      const capturedAt = new Date();
      const sourceFreshness = opts?.invokedToolNames
        ? await resolveChatFreshness(scopedDb, opts.invokedToolNames, capturedAt, {
            connectorSyncAt: this.connectorSyncAt
          })
        : (opts?.sourceFreshness ?? null);

      const completedOpts = {
        sourceFreshness,
        answerProvenance: opts?.answerProvenance,
        attachments: opts?.attachments,
        actionResults: opts?.actionResults,
        activityRecords: opts?.activityRecords,
        elapsedMs: opts?.elapsedMs,
        usage: opts?.usage
      };
      const result = thread.incognito
        ? undefined
        : "executed" in turn
          ? await this.chat.recordCompletedTurn(
              scopedDb,
              thread.id,
              userText,
              assistantReply,
              turn.executed,
              completedOpts,
              chatSurface
            )
          : await this.chat.recordGateCompletedTurn(
              scopedDb,
              thread.id,
              userText,
              assistantReply,
              turn.origin,
              completedOpts,
              chatSurface
            );

      if (thread.incognito) {
        return undefined;
      }

      const allMessages = await this.chat.listMessages(scopedDb, thread.id);
      const storedTurns = allMessages.filter(
        (m) => m.status === "stored" && (m.role === "user" || m.role === "assistant")
      );
      // Auto-title the thread from the first user turn (#403).
      if (storedTurns.length === 2 && thread.title === DEFAULT_CONVERSATION_TITLE) {
        await this.chat.updateThreadTitle(scopedDb, thread.id, deriveChatTitle(userText));
      }

      if (this.boss && result && !thread.incognito) {
        const messageId = result.assistantMessage.id;
        const embedPayload: EmbedTurnJobPayload = {
          actorUserId,
          threadId: thread.id,
          messageId
        };
        const extractPayload: ExtractFactsJobPayload = {
          actorUserId,
          threadId: thread.id,
          userMessageId: result.userMessage.id,
          assistantMessageId: result.assistantMessage.id
        };
        await sendJob(this.boss, CHAT_EMBED_TURN_QUEUE, embedPayload);
        await sendJob(this.boss, CHAT_EXTRACT_FACTS_QUEUE, extractPayload);
        await this.sendSummaryJobIfDue(actorUserId, thread, storedCoverageTurns(allMessages));

        const archiveEnabled = await this.localePreferences?.get(
          scopedDb,
          CHAT_ARCHIVE_ENABLED_PREF_KEY
        );
        if (archiveEnabled === true) {
          const localeRaw = await this.localePreferences?.get(scopedDb, "locale");
          const timezone = extractTimezone(localeRaw) ?? "UTC";
          const archivePayload: ArchiveDayJobPayload = {
            actorUserId,
            localDate: localDay(capturedAt, timezone)
          };
          await sendJob(this.boss, CHAT_ARCHIVE_DAY_QUEUE, archivePayload);
        }
      }
      return result
        ? {
            userMessageId: result.userMessage.id,
            assistantMessageId: result.assistantMessage.id,
            sourceFreshness
          }
        : undefined;
    });
  }

  async openNewConversation(
    actorUserId: string,
    options?: { incognito?: boolean },
    surface?: ChatSurface
  ): Promise<void> {
    const chatSurface = normalizeChatSurface(surface);
    await this.run(actorUserId, "open-new-conversation", (scopedDb) =>
      this.chat.openNewThread(scopedDb, {
        title: DEFAULT_CONVERSATION_TITLE,
        incognito: options?.incognito,
        surface: chatSurface
      })
    );
  }

  async touchExistingThread(
    actorUserId: string,
    threadId: string,
    surface?: ChatSurface
  ): Promise<boolean> {
    const chatSurface = normalizeChatSurface(surface);
    const found = await this.run(actorUserId, "touch-existing-thread", (scopedDb) =>
      this.chat.touchThread(scopedDb, threadId, chatSurface)
    );
    return found !== undefined;
  }

  /**
   * Ask for the conversation's uncovered history to be condensed. Used when a fresh
   * launch refuses an over-budget replay. Private, foreign and other-surface threads
   * are ignored.
   */
  async requestConversationSummary(
    actorUserId: string,
    binding: { readonly threadId?: string | null },
    surface?: ChatSurface
  ): Promise<void> {
    const threadId = binding.threadId;
    if (!this.boss || threadId === null) return;
    const chatSurface = normalizeChatSurface(surface);
    await this.run(actorUserId, "request-conversation-summary", async (scopedDb) => {
      const thread =
        threadId === undefined
          ? await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface)
          : await this.chat.getThreadById(scopedDb, threadId, chatSurface);
      if (!thread || thread.owner_user_id !== actorUserId || thread.surface !== chatSurface) return;
      const messages = await this.chat.listMessages(scopedDb, thread.id);
      await this.sendSummaryJobIfDue(actorUserId, thread, storedCoverageTurns(messages));
    });
  }

  /** Queue one summarization run when the uncovered suffix outgrows the replay window. */
  private async sendSummaryJobIfDue(
    actorUserId: string,
    thread: ChatThread,
    turns: readonly CoverageTurn[]
  ): Promise<void> {
    if (!this.boss || thread.incognito) return;
    const split = splitAtSummaryFrontier(turns, {
      summary: thread.conversation_summary,
      coveredThroughMessageId: thread.summary_covered_through_message_id,
      revision: thread.summary_revision
    });
    const plan = planSummaryCoverage(split.uncovered, {
      keep: getReplayK(),
      replayTokens: getReplayTokenCap(),
      maxInputTokens: SUMMARY_RUN_INPUT_TOKENS
    });
    if (!plan) return;
    const payload: SummarizeConversationJobPayload = {
      actorUserId,
      threadId: thread.id,
      expectedRevision: thread.summary_revision,
      expectedCoveredThroughMessageId: thread.summary_covered_through_message_id,
      throughMessageId: plan.throughMessageId
    };
    await sendJob(this.boss, CHAT_SUMMARIZE_CONVERSATION_QUEUE, payload, {
      singletonKey: `${thread.id}:${thread.summary_revision}`
    });
  }

  async getCurrentThreadState(
    actorUserId: string,
    surface?: ChatSurface
  ): Promise<{ readonly id: string; readonly incognito: boolean } | undefined> {
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "get-current-thread-state", async (scopedDb) => {
      const thread = await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface);
      return thread ? { id: thread.id, incognito: thread.incognito } : undefined;
    });
  }

  async getMainThreadState(
    actorUserId: string
  ): Promise<{ readonly id: string; readonly incognito: boolean } | undefined> {
    return this.run(actorUserId, "get-main-thread-state", async (scopedDb) => {
      const thread = await this.chat.getMainThread(scopedDb, actorUserId);
      return thread ? { id: thread.id, incognito: thread.incognito } : undefined;
    });
  }

  async getOwnedThreadState(
    actorUserId: string,
    threadId: string
  ): Promise<
    { readonly id: string; readonly surface: ChatSurface; readonly incognito: boolean } | undefined
  > {
    if (!threadId) return undefined;
    return this.run(actorUserId, "get-owned-thread-state", async (scopedDb) => {
      const thread = await this.chat.getOwnedThreadById(scopedDb, actorUserId, threadId);
      return thread?.owner_user_id === actorUserId
        ? {
            id: thread.id,
            surface: normalizeChatSurface(thread.surface),
            incognito: thread.incognito
          }
        : undefined;
    });
  }

  async persistActionRecord(
    actorUserId: string,
    threadId: string,
    record: TranscriptRecord
  ): Promise<boolean> {
    const terminal = terminalActionRecord(record);
    if (!threadId || !terminal) return false;
    return this.run(actorUserId, "persist-action-record", (scopedDb) =>
      this.chat.persistActionRecord(scopedDb, actorUserId, threadId, terminal)
    );
  }

  async deleteThread(actorUserId: string, threadId: string, _surface?: ChatSurface): Promise<void> {
    await this.run(actorUserId, "delete-thread", (scopedDb) =>
      sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${threadId}::uuid)`.execute(
        scopedDb.db
      )
    );
  }

  async listIncognitoThreadStates(): Promise<
    readonly {
      readonly actorUserId: string;
      readonly threadId: string;
      readonly surface: ChatSurface;
    }[]
  > {
    if (!this.rootDb) return [];
    const result = await sql<{
      actorUserId: string;
      threadId: string;
      surface: ChatSurface;
    }>`
      SELECT actor_user_id AS "actorUserId", thread_id AS "threadId", surface
      FROM app.list_incognito_chat_threads_for_cleanup()
    `.execute(this.rootDb);
    return result.rows;
  }

  async getThreadContext(
    actorUserId: string,
    surface?: ChatSurface,
    threadId?: string | null
  ): Promise<{ threadTitle: string | null; localTimezone: string | null; incognito: boolean }> {
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "get-thread-context", async (scopedDb) => {
      const [thread, localeRaw] = await Promise.all([
        threadId === undefined
          ? this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface)
          : threadId
            ? this.chat.getThreadById(scopedDb, threadId, chatSurface)
            : undefined,
        this.localePreferences?.get(scopedDb, "locale") ?? null
      ]);
      if (
        threadId !== undefined &&
        (!thread || thread.owner_user_id !== actorUserId || thread.surface !== chatSurface)
      ) {
        throw new Error("Conversation is unavailable for context retrieval");
      }
      const title = thread?.title ?? null;
      // #2157: the prompt's time block must agree with the clock tool and Settings.
      const localTimezone = resolveEffectiveTimezone(localeRaw);
      return {
        threadTitle: title && title !== DEFAULT_CONVERSATION_TITLE ? title : null,
        localTimezone,
        incognito: thread?.incognito ?? false
      };
    });
  }

  /**
   * Resolve the acting user's display name (for persona rendering). Reads the
   * foundation app.users row under the actor's data context; falls back to the
   * actorUserId when the name is empty/missing. Not part of ChatPersistencePort —
   * the live routes call it to seed renderPersona's {{userName}} token.
   */
  async resolveUserName(actorUserId: string): Promise<string> {
    return this.run(actorUserId, "resolve-user-name", async (scopedDb) => {
      assertDataContextDb(scopedDb);
      const row = await scopedDb.db
        .selectFrom("app.users")
        .select("name")
        .where("id", "=", actorUserId)
        .executeTakeFirst();
      const name = row?.name?.trim();
      return name && name.length > 0 ? name : actorUserId;
    });
  }

  private run<T>(
    actorUserId: string,
    operation: string,
    fn: (scopedDb: DataContextDb) => Promise<T>
  ): Promise<T> {
    return this.dataContext.withDataContext(
      { actorUserId, requestId: `chat-live:${operation}` },
      fn
    );
  }
}

/**
 * Map the router's broad AiProviderKind onto the narrow live ProviderKind the CLI
 * engines support. ollama/custom have no live CLI engine in Phase 1 → throw a
 * clear error rather than silently dispatching an unsupported provider.
 */
function toLiveProvider(model: AiConfiguredModelSafeRow): ProviderKind {
  const kind = model.provider_kind;
  if ((LIVE_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    return kind as ProviderKind;
  }
  if (model.provider_auth_method === "cli" && !model.provider_acp_agent_id) {
    throw new UnsupportedLegacyCliProviderError();
  }
  throw new Error(
    `Active chat model uses provider kind "${kind}", which has no live CLI engine in Phase 1.`
  );
}

function deriveChatTitle(userText: string): string {
  const first = userText.split(/[.!?\n]/)[0] ?? userText;
  const cleaned = first.replace(/[^\S\r\n]+/g, " ").trim();
  const capped = cleaned.length > 60 ? `${cleaned.slice(0, 57).trimEnd()}…` : cleaned;
  const titled = capped.charAt(0).toUpperCase() + capped.slice(1);
  if (!titled || containsSensitiveMemoryText(titled)) return DEFAULT_CONVERSATION_TITLE;
  return titled;
}
