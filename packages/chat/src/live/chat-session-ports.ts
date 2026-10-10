/**
 * Persistence + passive-retrieval port interfaces for ChatSessionManager, split out of
 * chat-session-manager.ts (#1157) to keep that file under the repo's 1000-line cap. All
 * names are re-exported from chat-session-manager.ts so existing import paths keep working.
 */

import type { ConversationProvenancePort, ProviderKind } from "@moss/ai";
import type {
  AiAuthMethod,
  AnswerProvenanceMetadataV1,
  ChatAttachmentDto,
  ChatSurface,
  ChatClassifierGateOriginV1,
  ChatTurnOriginV1,
  ChatTurnUsageDto,
  SourceFreshnessV1
} from "@moss/shared";
import type { MemoryRecallItem } from "@moss/memory";
import type { PriorityModelPreferenceV1 } from "@moss/priority";
import type { RecallPort } from "../recall-port.js";
import type { ClassifierGateShadowRunner } from "./classifier-gate-shadow.js";
import type { CrossToolReadRunner } from "./cross-tool-reasoning.js";
import type { NotesContextRetriever } from "./notes-retrieval.js";
import type { PersonaFs } from "./persona.js";
import type { AcpPermissionDecider } from "@moss/acp";
import type { ClassifierGateRunner } from "./classifier-gate-runner.js";
import type { ReminderTurnPlan } from "../reminders/turn.js";
import type {
  ActionResultMetadata,
  CliChatEngine,
  EngineKillOpts,
  TranscriptRecord
} from "./types.js";

/** `no_route`: no configured model can summarize, so the conversation cannot be condensed. */
export type ConversationSummaryRequestStatus = "queued" | "skipped" | "no_route";

export interface PrivateThreadState {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly surface?: ChatSurface;
}

export interface ChatPersistencePort {
  /** The active "chat" provider+model for this user (router-selected). */
  resolveActiveProvider(actorUserId: string): Promise<{
    provider: ProviderKind;
    model: string;
    /** Production persistence always supplies these; optional for legacy embedders and test ports. */
    providerConfigId?: string;
    authMethod?: AiAuthMethod;
    acpAgentId?: string | null;
    acpModel?: string;
  }>;
  /** The accepted summary plus every stored turn after its covered frontier. */
  listPriorTurns(
    actorUserId: string,
    opts?: { readonly forceReplay?: boolean; readonly threadId?: string | null },
    surface?: ChatSurface
  ): Promise<{
    recent: readonly { role: "user" | "assistant"; content: string }[];
    oldSummary: string | null;
  }>;
  /**
   * Ask for the bound conversation's older turns to be condensed into its summary.
   * Best-effort; the caller never waits on the summary itself.
   */
  requestConversationSummary?(
    actorUserId: string,
    binding: { readonly threadId?: string | null },
    surface?: ChatSurface
  ): Promise<ConversationSummaryRequestStatus | void>;
  /** Persist a completed turn (user text + assistant reply + executing provider/model). */
  recordTurn(
    actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: {
      /** Captured conversation; null refuses persistence, omitted keeps legacy lookup. */
      readonly threadId?: string | null;
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly answerProvenance?: AnswerProvenanceMetadataV1;
      /** #1133 — display metadata for files sent with this turn (user-message tool_metadata). */
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
      readonly activityRecords?: readonly TranscriptRecord[];
      readonly elapsedMs?: number;
      readonly usage?: ChatTurnUsageDto;
      /** #3311 — reserved reminder message ids this turn was shown; acknowledged with the save. */
      readonly acknowledgeReminderMessageIds?: readonly string[];
    },
    surface?: ChatSurface
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly sourceFreshness?: SourceFreshnessV1 | null;
      }
    | undefined
  >;
  /**
   * #3311 — delivered reminders whose context is still pending in this exact Main chat, oldest
   * first and bounded. Optional: embedders without reminders omit it.
   */
  listPendingMainReminders?(
    actorUserId: string,
    threadId: string
  ): Promise<readonly PendingMainReminder[]>;
  /**
   * Task 4.1 (#2901) — persist one completed gate-handled turn. The assistant message carries the
   * gate-origin contract instead of an executed provider/model or usage. Optional: embedders that
   * never wire the gate omit it.
   */
  recordHandledTurn?(
    actorUserId: string,
    userText: string,
    assistantReply: string,
    origin: ChatClassifierGateOriginV1,
    opts?: HandledTurnOptions,
    surface?: ChatSurface
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly sourceFreshness?: SourceFreshnessV1 | null;
      }
    | undefined
  >;
  /**
   * #3309 — persist the code-written answer to a recognised reminder request, saving and queuing
   * an accepted reminder in the same transaction. Optional: embedders without reminders omit it.
   */
  recordReminderTurn?(
    actorUserId: string,
    userText: string,
    plan: ReminderTurnPlan,
    opts?: ReminderTurnOptions,
    surface?: ChatSurface
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly reply: string;
        readonly origin: ChatTurnOriginV1;
      }
    | "stopped"
    | undefined
  >;
  /** Close the current conversation and open a fresh one (for /clear). */
  openNewConversation(
    actorUserId: string,
    options?: { incognito?: boolean },
    surface?: ChatSurface
  ): Promise<void>;
  getCurrentThreadState?(
    actorUserId: string,
    surface?: ChatSurface
  ): Promise<{ readonly id: string; readonly incognito: boolean } | undefined>;
  /** Stable drawer destination for a cold reconnect; explicit resume stays on current-thread state. */
  getMainThreadState?(
    actorUserId: string
  ): Promise<{ readonly id: string; readonly incognito: boolean } | undefined>;
  /** Exact owner-scoped lookup; never substitutes the active conversation. */
  getOwnedThreadState?(
    actorUserId: string,
    threadId: string
  ): Promise<
    { readonly id: string; readonly surface: ChatSurface; readonly incognito: boolean } | undefined
  >;
  /** True only after saving or confirming an identical owned nonprivate terminal record. */
  persistActionRecord?(
    actorUserId: string,
    threadId: string,
    record: TranscriptRecord
  ): Promise<boolean>;
  listIncognitoThreadStates?(): Promise<readonly PrivateThreadState[]>;
  deleteThread?(actorUserId: string, threadId: string, surface?: ChatSurface): Promise<void>;
  /** Return the current thread title and the user's persisted timezone (null if unset). */
  getThreadContext(
    actorUserId: string,
    surface?: ChatSurface,
    threadId?: string | null
  ): Promise<{ threadTitle: string | null; localTimezone: string | null; incognito: boolean }>;
  /**
   * Make threadId the current thread for actorUserId (for resume). Returns true if
   * the thread was found and touched; false if it does not exist or belongs to another user.
   */
  touchExistingThread(
    actorUserId: string,
    threadId: string,
    surface?: ChatSurface
  ): Promise<boolean>;
}

export interface PassiveRetrievalPort {
  retrieve(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
  }): Promise<string>;
  retrieveWithItems?(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
  }): Promise<{ block: string; items: MemoryRecallItem[] }>;
}

export interface Clock {
  now(): number;
}

/**
 * Task 4.1 (#2901) — extras carried by a gate-handled completed turn. Deliberately narrower than the
 * model-turn options: a handled turn has no model, no usage and no engine transcript, so there is no
 * elapsedMs/usage/invokedToolNames to pass. Source freshness and activity/action records still ride
 * along, because a handled read/write is a real module action with a real result.
 */
export interface HandledTurnOptions {
  /** Captured conversation; null refuses persistence, omitted keeps legacy lookup. */
  readonly threadId?: string | null;
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  readonly attachments?: readonly ChatAttachmentDto[];
  readonly actionResults?: readonly ActionResultMetadata[];
  readonly activityRecords?: readonly TranscriptRecord[];
}

/** A stop that lands before the reminder turn commits rolls the whole turn back. */
export interface ReminderTurnOptions extends HandledTurnOptions {
  readonly stopSignal?: AbortSignal;
}

export interface ChatSessionManagerDeps {
  readonly engineFactory: (
    provider: ProviderKind,
    sessionKey: string,
    opts?: {
      readonly conversationId?: string;
      readonly userId?: string;
      readonly providerConfigId?: string;
      readonly acpAgentId?: string | null;
      readonly acpModel?: string;
      readonly nextSequence?: () => number;
    }
  ) => CliChatEngine | Promise<CliChatEngine>;
  readonly persistence: ChatPersistencePort;
  readonly conversationProvenance?: Pick<ConversationProvenancePort, "recordAdmission">;
  /**
   * Task 4.1 (#2901) — the classifier gate lifecycle seam. When present, `runTurn` reads its admin
   * mode first; `off`/`shadow` do nothing (shadow wiring is 3.5), and `on` may handle the turn
   * without launching an engine. Absent ⇒ every turn follows today's default-model path unchanged.
   */
  readonly classifierGate?: ClassifierGateRunner;
  /**
   * #2907 (plan 3.5) — the classifier gate's shadow runner. When present, `runTurn` starts one
   * shadow attempt alongside the default turn and reports the model's first tool record so the
   * hypothetical decision can be compared. Absent ⇒ no shadow attempts and no behavior change.
   */
  readonly classifierGateShadow?: ClassifierGateShadowRunner;
  readonly personaFs: PersonaFs;
  readonly clock: Clock;
  readonly idleMs: number;
  /** Base dir for renderPersona (per-user neutral dirs are created under it). */
  readonly neutralBase: string;
  /** Persona text (may contain a {{userName}} token). */
  readonly persona:
    | string
    | ((actorUserId: string, userName: string, surface: ChatSurface) => Promise<string>);
  /** Delay between readNew polls (default 25ms; tests pass 0). */
  readonly pollMs?: number;
  /**
   * #456 — idle/heartbeat watchdog window (ms). The deadline resets whenever readNew yields new
   * transcript records; only a turn that emits NOTHING for this window trips it (accurate status
   * record, NOT the old broken TIMEOUT_MESSAGE). Default 180000 (3 min); composition root resolves
   * JARVIS_CHAT_IDLE_WATCHDOG_MS. This is NOT a duration cap — an actively-producing turn (multi-tool,
   * 3+ min) never trips it.
   */
  readonly idleWatchdogMs?: number;
  readonly mintMcpToken?: (
    actorUserId: string,
    chatSessionId: string,
    threadId: string | null
  ) => Promise<{ token: string; mcpServerUrl: string }>;
  readonly revokeMcpToken?: (chatSessionId: string) => void;
  /** Refresh the session token's TTL on activity, so a live session's token never
   *  expires under the registry backstop (mirrors lastActivity / idle reaping). */
  readonly touchMcpToken?: (chatSessionId: string) => void;
  /** Wait for origin-bound gateway notifications before completing their model/gate turn. */
  readonly flushActionRecords?: (chatSessionId: string) => Promise<void>;
  /**
   * #2956: file this session's tool rows under the running turn. Set when a
   * turn starts, cleared in the same finally that releases the turn. Absent
   * (tests, embedders) means tool rows carry no turn id.
   */
  readonly setCurrentTurnId?: (chatSessionId: string, turnId: string) => void;
  readonly clearCurrentTurnId?: (chatSessionId: string) => void;
  /**
   * #2159 — resolves once this session's MCP client has completed its first tools/list round
   * trip (or resolves `false` after a bounded timeout if it never does — see
   * `SessionTokenRegistry.waitForToolsListObserved`). `launchSession` awaits this right after
   * `engine.launch()`, before the session is added to `sessions`, so nothing can submit a turn
   * against a session whose CLI has not yet confirmed it knows its real tool set. Absent ⇒ no
   * gate (host/in-process path that mints no tokens).
   */
  readonly waitForToolsListReady?: (token: string) => Promise<boolean>;
  /**
   * #2164 r21 — reads this token's current tools/list observation count (see
   * `SessionTokenRegistry.getToolsListObservationCount`). A bounded-fallback engine reconnects
   * a fresh MCP client every turn, so `runTurn` captures this as a baseline right before each
   * submit and checks it again after the turn to prove a NEW attach landed for THIS turn —
   * distinct from `waitForToolsListReady`'s one-time "ever observed" launch gate, which this
   * does not change. Absent ⇒ the per-turn guard does not run (unchanged from pre-r21 behavior).
   */
  readonly getToolsListObservationCount?: (token: string) => number;
  /**
   * #342 (§5.3 step 2) — revoke every MCP token whose chatSessionId is NOT in the live set.
   * Wraps SessionTokenRegistry.reconcile(liveSessionIds). The ONE source for orphan-token
   * revocation: it works off the token registry, so it sweeps orphaned tokens even when
   * `sessions` is empty (an api restart). Absent ⇒ reconciliation skips the token sweep
   * (host/in-process path that mints no tokens).
   */
  readonly reconcileMcpTokens?: (liveSessionIds: Set<string>) => void;
  /**
   * #342 (§5.3 steps 2/4) — every chatSessionId the token registry currently holds a token
   * for (SessionTokenRegistry.listSessionIds). After an api restart the `sessions` Map is
   * empty, so this — not the Map — is what tells reconciliation which orphaned mux sessions
   * to reap by name. Absent ⇒ reconciliation reaps only sessions the Map knows about.
   */
  readonly listMcpTokenSessionIds?: () => string[];
  /**
   * #342 (§4.5 / §5.3 step 4) — issue a `kill` for a sessionKey the manager has NO engine
   * object for (an api-unknown live mux session after an api restart). The RPC client kills
   * BY MUX NAME over the socket; the in-process path can no-op (a host install has no
   * separate cli-runner to hold orphans). Idempotent. Absent ⇒ orphan-by-name reaping is
   * skipped (only Map-known sessions are killed via their engine).
   */
  readonly killSession?: (sessionKey: string, opts?: EngineKillOpts) => Promise<void>;
  readonly purgePrivateTranscripts?: (sessionKey: string) => Promise<void>;
  /** Builds the gateway-backed ACP decider for a freshly minted session token. */
  readonly acpPermissionDeciderForToken?: (token: string) => AcpPermissionDecider;
  /** Phase 3: optional recall service — injects <memory> seed before replay. */
  readonly recall?: RecallPort;
  /** Optional per-turn hidden context retrieval. Empty/failed result submits the raw turn. */
  readonly passiveRetrieval?: PassiveRetrievalPort;
  readonly notesRetrieval?: Pick<NotesContextRetriever, "retrieveWithItems">;
  readonly crossToolRead?: CrossToolReadRunner;
  readonly priorityModel?: { getModel(actorUserId: string): Promise<PriorityModelPreferenceV1> };
  /**
   * #342 (§4.1.2) — does the ENGINE own the replay submit+drain?
   *
   * `false` (default, in-process path): the engine ignores `replayBatch`/`personaText`,
   * returns `{ offset: 0 }`, and the MANAGER submits + drains the replay itself below.
   *
   * `true` (RPC path): the cli-runner server wrote the persona file, submitted `replayBatch`,
   * and drained the transcript server-side; `launch` returns the real post-drain offset and the
   * manager does NO further submit/drain.
   *
   * This is an EXPLICIT discriminator and MUST be used instead of the `offset === 0` sentinel:
   * `offset === 0` is ALSO a legitimate RPC result (a replay was submitted but the transcript
   * never materialized within the server's drain budget), so keying the in-process re-drain on
   * `offset === 0` would cause the manager to DOUBLE-submit the replay over the socket.
   *
   * CROSS-LANE (Lane A wiring): set `serverOwnsDrain = true` exactly when the RPC engine factory
   * is selected (socket configured); leave it `false`/absent for the in-process factory.
   */
  readonly serverOwnsDrain?: boolean;
  // Wall-clock seam for buildEngineText's time context; deliberately separate from `clock` above (idle/heartbeat elapsed time).
  readonly now?: () => Date;
}

export interface PendingMainReminder {
  readonly reservedMessageId: string;
  readonly body: string;
}
