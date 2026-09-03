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
  resolveMossEnv,
  type DataContextDb,
  type DataContextRunner,
  type MossDatabase,
  type PreferencesPort
} from "@moss/db";
import type {
  AnswerProvenanceMetadataV1,
  AiProviderExecutionMode,
  ChatAttachmentDto,
  ChatSurface,
  SourceFreshnessEntry,
  SourceFreshnessV1
} from "@moss/shared";
import { localDay } from "@moss/shared";
import { CHAT_ARCHIVE_ENABLED_PREF_KEY } from "@moss/settings";
import type { ActionResultMetadata } from "./types.js";
import type { PgBoss } from "pg-boss";

import { sendJob } from "@moss/jobs";

import {
  CHAT_ARCHIVE_DAY_QUEUE,
  CHAT_EMBED_TURN_QUEUE,
  CHAT_EXTRACT_FACTS_QUEUE,
  type ArchiveDayJobPayload,
  type EmbedTurnJobPayload,
  type ExtractFactsJobPayload
} from "../jobs.js";
import { containsSensitiveMemoryText } from "../memory-distillation.js";
import type { ChatPersistencePort } from "./chat-session-manager.js";
import type { ChatRepository } from "../repository.js";
import { normalizeChatSurface } from "./chat-surface.js";
import { estimateTokens } from "./recall-seed.js";
import {
  capSummary,
  DEFAULT_REPLAY_MESSAGES,
  REPLAY_TOKEN_CAP,
  SUMMARY_TOKEN_CAP,
  selectReplayWindow,
  type ReplayMessage
} from "./replay-window.js";

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
  const entries: SourceFreshnessEntry[] = await Promise.all(
    [...sourceKeys].map(async (source): Promise<SourceFreshnessEntry> => {
      if (REALTIME_SOURCES_CHAT.has(source)) {
        return { source, freshnessKind: "realtime", asOf: capturedAtIso };
      }
      if (CONNECTOR_SOURCES_CHAT.has(source)) {
        let asOf: string | null = null;
        try {
          const t =
            (await opts.connectorSyncAt?.(scopedDb, source as "email" | "calendar")) ?? null;
          asOf = t ? t.toISOString() : null;
        } catch {
          // keep asOf as null on error
        }
        return { source, freshnessKind: "connector_sync", asOf };
      }
      // vault — V1: asOf: null (no vaultLastWriteAt dep for chat)
      return { source, freshnessKind: "vault_write", asOf: null };
    })
  );

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

  constructor(deps: DataContextChatPersistenceDeps) {
    this.rootDb = deps.rootDb;
    this.dataContext = deps.dataContext;
    this.chat = deps.chatRepository;
    this.ai = deps.aiRepository;
    this.boss = deps.boss;
    this.connectorSyncAt = deps.connectorSyncAt;
    this.localePreferences = deps.localePreferences;
  }

  async resolveActiveProvider(
    actorUserId: string
  ): Promise<{ provider: ProviderKind; model: string; executionMode: AiProviderExecutionMode }> {
    const model = await this.run(actorUserId, "resolve-provider", (scopedDb) =>
      this.ai.selectChatModelForUser(scopedDb)
    );

    if (!model) {
      throw new Error("No active chat-capable model is configured for this user.");
    }

    return {
      provider: toLiveProvider(model),
      model: model.provider_model_id,
      executionMode: model.provider_execution_mode
    };
  }

  async listPriorTurns(
    actorUserId: string,
    opts?: { readonly forceReplay?: boolean },
    surface?: ChatSurface
  ): Promise<{
    recent: readonly ReplayMessage[];
    oldSummary: string | null;
  }> {
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "list-prior-turns", async (scopedDb) => {
      const thread = await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface);
      if (!thread) return { recent: [], oldSummary: null };

      // D4: incognito replays nothing, enforced here regardless of caller. No
      // further window/summary work runs for an incognito thread.
      if (thread.incognito) {
        return { recent: [], oldSummary: null };
      }

      const messages = await this.chat.listMessages(scopedDb, thread.id);
      const turns: ReplayMessage[] = messages
        .filter((m) => m.status === "stored" && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.body }));

      const recent = selectReplayWindow(turns, {
        maxMessages: getReplayK(),
        maxTokens: getReplayTokenCap()
      });
      const oldSummary = thread.conversation_summary
        ? capSummary(thread.conversation_summary, SUMMARY_TOKEN_CAP)
        : null;

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
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly answerProvenance?: AnswerProvenanceMetadataV1;
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
    },
    surface?: ChatSurface
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string } | undefined> {
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "record-turn", async (scopedDb) => {
      const thread =
        (await this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface)) ??
        (await this.chat.openNewThread(scopedDb, {
          title: DEFAULT_CONVERSATION_TITLE,
          surface: chatSurface
        }));

      const capturedAt = new Date();
      const sourceFreshness = opts?.invokedToolNames
        ? await resolveChatFreshness(scopedDb, opts.invokedToolNames, capturedAt, {
            connectorSyncAt: this.connectorSyncAt
          })
        : null;

      const result = thread.incognito
        ? undefined
        : await this.chat.recordCompletedTurn(
            scopedDb,
            thread.id,
            userText,
            assistantReply,
            executed,
            {
              sourceFreshness,
              answerProvenance: opts?.answerProvenance,
              attachments: opts?.attachments,
              actionResults: opts?.actionResults
            },
            chatSurface
          );
      await this.chat.touchThread(scopedDb, thread.id);

      if (thread.incognito) {
        return undefined;
      }

      // Update rolling summary when stored turns exceed the replay window. D3:
      // the write gate uses the constant, not the (possibly opted-out) env —
      // summaries keep accruing for long threads regardless of replay overrides.
      const allMessages = await this.chat.listMessages(scopedDb, thread.id);
      const storedTurns = allMessages.filter(
        (m) => m.status === "stored" && (m.role === "user" || m.role === "assistant")
      );
      // Auto-title the thread from the first user turn (#403).
      if (storedTurns.length === 2 && thread.title === DEFAULT_CONVERSATION_TITLE) {
        await this.chat.updateThreadTitle(scopedDb, thread.id, deriveChatTitle(userText));
      }

      if (storedTurns.length > DEFAULT_REPLAY_MESSAGES) {
        const oldTurns = storedTurns.slice(0, -DEFAULT_REPLAY_MESSAGES).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.body
        }));
        await this.chat.updateConversationSummary(
          scopedDb,
          thread.id,
          buildRollingSummary(oldTurns)
        );
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
    surface?: ChatSurface
  ): Promise<{ threadTitle: string | null; localTimezone: string | null; incognito: boolean }> {
    const chatSurface = normalizeChatSurface(surface);
    return this.run(actorUserId, "get-thread-context", async (scopedDb) => {
      const [thread, localeRaw] = await Promise.all([
        this.chat.getCurrentThread(scopedDb, actorUserId, chatSurface),
        this.localePreferences?.get(scopedDb, "locale") ?? null
      ]);
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
  throw new Error(
    `Active chat model uses provider kind "${kind}", which has no live CLI engine in Phase 1.`
  );
}

/**
 * D1: unset/empty -> DEFAULT_REPLAY_MESSAGES (40); explicit "0" -> 0 (valid
 * opt-out); non-numeric or negative -> 40 plus one console.warn. Exported so
 * tests/unit/chat-replay-window.test.ts can unit-test the parsing directly.
 */
export function getReplayK(): number {
  const val = resolveMossEnv(process.env, "JARVIS_CHAT_REPLAY_K");
  if (val === undefined || val === "") return DEFAULT_REPLAY_MESSAGES;
  const parsed = parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `Invalid JARVIS_CHAT_REPLAY_K value "${val}"; defaulting to ${DEFAULT_REPLAY_MESSAGES}.`
    );
    return DEFAULT_REPLAY_MESSAGES;
  }
  return parsed;
}

/** D1: sibling override for REPLAY_TOKEN_CAP. Same resolver, same parse rules. */
function getReplayTokenCap(): number {
  const val = resolveMossEnv(process.env, "JARVIS_CHAT_REPLAY_TOKENS");
  if (val === undefined || val === "") return REPLAY_TOKEN_CAP;
  const parsed = parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `Invalid JARVIS_CHAT_REPLAY_TOKENS value "${val}"; defaulting to ${REPLAY_TOKEN_CAP}.`
    );
    return REPLAY_TOKEN_CAP;
  }
  return parsed;
}

function deriveChatTitle(userText: string): string {
  const first = userText.split(/[.!?\n]/)[0] ?? userText;
  const cleaned = first.replace(/[^\S\r\n]+/g, " ").trim();
  const capped = cleaned.length > 60 ? `${cleaned.slice(0, 57).trimEnd()}…` : cleaned;
  const titled = capped.charAt(0).toUpperCase() + capped.slice(1);
  if (!titled || containsSensitiveMemoryText(titled)) return DEFAULT_CONVERSATION_TITLE;
  return titled;
}

function buildRollingSummary(
  oldTurns: readonly { role: "user" | "assistant"; content: string }[]
): string {
  const priorContent = oldTurns
    .map((m) => `${m.role}: ${m.content.trim()}`)
    .filter(Boolean)
    .join(" ");
  const raw = `As of turn ${oldTurns.length}: ${priorContent}`;
  // Cap to 2000 chars so the column stays bounded while retaining the oldest summarized facts.
  return raw.length > 2000 ? `${raw.slice(0, 1997)}...` : raw;
}
