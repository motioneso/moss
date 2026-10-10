import type { ProviderKind } from "@moss/ai";
import type { SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import {
  discardChatSession,
  dropSessionsForProvider,
  ensureSessionForCurrentProvider,
  switchChatProviderSession,
  type ActiveChatProvider,
  type UserSession
} from "./chat-session-provider-identity.js";
import { launchChatSession, seedChatContext } from "./chat-session-launch.js";
import { ChatStreamLimitError, ChatTurnInFlightError } from "./errors.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";
import type { ReapReason } from "./provider-runtime.js";
import {
  applyRemoteReap,
  clearChatSession,
  countSubscribersFor,
  clearPrivateDetachTimer,
  endPrivateChatSession,
  resumeChatThread,
  stopSessionTurn,
  type PendingActionResult,
  type SessionRecoveryHost,
  schedulePrivateDetachTimer,
  reconcileChatSessions
} from "./session-runtime-helpers.js";
import {
  DEFAULT_CHAT_SURFACE,
  normalizeChatSurface,
  surfaceSessionKey,
  type ChatSurface
} from "./chat-surface.js";

export {
  combineHiddenContextBlocks,
  renderNotesContextBlock,
  renderReplayBlock,
  renderSummaryBlock
} from "./chat-context-blocks.js";
export { ChatStreamLimitError, ChatThreadNotFoundError, ChatTurnInFlightError } from "./errors.js";
import type {
  ChatPersistencePort,
  ChatSessionManagerDeps,
  Clock,
  PassiveRetrievalPort,
  PrivateThreadState
} from "./chat-session-ports.js";
import {
  routeMainBackgroundMessage,
  type MainBackgroundMessage
} from "./background-message-routing.js";
import { getSelectedThreadState, usesMainThreadSelection } from "./chat-thread-selection.js";
import {
  routeOriginRecord,
  routeLiveOriginRecord,
  withOriginThreadTransition,
  waitForChatAdmission,
  waitForOriginThreadTransition,
  type OriginRecordReceipt,
  type OriginThreadTransition
} from "./origin-record-routing.js";
import { runChatTurn, type ChatTurnHost } from "./chat-session-turn.js";
export type {
  ChatPersistencePort,
  ChatSessionManagerDeps,
  Clock,
  PassiveRetrievalPort,
  PrivateThreadState
};

type Subscriber = (record: TranscriptRecord) => void;

const MAX_SUBSCRIBERS_PER_ACTOR = 5;
const MAX_SUBSCRIBERS_TOTAL_PER_ACTOR = MAX_SUBSCRIBERS_PER_ACTOR * 2;

export class ChatSessionManager {
  private readonly sessions = new Map<string, UserSession>();
  private readonly originTransitions = new Map<string, OriginThreadTransition>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly privateDetachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight ensureSession promises, keyed by actor + surface, to serialize launches. */
  private readonly launching = new Map<string, Promise<UserSession>>();
  /** Actors whose next relaunch must replay bounded prior context after an explicit resume. */
  private readonly pendingForcedReplay = new Set<string>();
  /** #6.5 — one turn at a time per actor + surface. */
  private readonly turnsInFlight = new Set<string>();
  /** #456 — per-turn stop controllers, keyed by actor + surface. */
  private readonly turnControllers = new Map<string, AbortController>();
  private readonly actionResultsBySession = new Map<string, ActionResultMetadata[]>();
  private readonly turnActivityBySession = new Map<string, TranscriptRecord[]>();
  private readonly sequenceBySession = new Map<string, number>();
  private readonly pendingActionResultsBySession = new Map<string, PendingActionResult[]>();
  private readonly pollMs: number;
  /** #456 — idle/heartbeat watchdog window; 0 disables (tests only). */
  private readonly idleWatchdogMs: number;
  /** #342: RPC engines own replay submit/drain; in-process engines do it here. */
  private readonly serverOwnsDrain: boolean;
  /** #342: serializes reconciliation and idle reaping, which both mutate sessions/tokens. */
  private maintenanceMutex: Promise<void> = Promise.resolve();
  private readonly lifecycleHost: SessionRecoveryHost;
  private readonly turnHost: ChatTurnHost;

  constructor(private readonly deps: ChatSessionManagerDeps) {
    this.pollMs = deps.pollMs ?? 25;
    this.idleWatchdogMs = deps.idleWatchdogMs ?? 180_000;
    this.serverOwnsDrain = deps.serverOwnsDrain ?? false;
    this.lifecycleHost = {
      deps,
      sessions: this.sessions,
      pendingForcedReplay: this.pendingForcedReplay,
      emit: this.emit.bind(this),
      ensureSession: this.ensureSession.bind(this)
    };
    this.turnHost = {
      deps,
      sessions: this.sessions,
      originTransitions: this.originTransitions,
      pendingForcedReplay: this.pendingForcedReplay,
      turnControllers: this.turnControllers,
      actionResultsBySession: this.actionResultsBySession,
      turnActivityBySession: this.turnActivityBySession,
      sequenceBySession: this.sequenceBySession,
      pendingActionResultsBySession: this.pendingActionResultsBySession,
      pollMs: this.pollMs,
      idleWatchdogMs: this.idleWatchdogMs,
      lifecycleHost: this.lifecycleHost,
      emit: this.emit.bind(this),
      ensureSession: this.ensureSession.bind(this)
    };
  }

  /** Ensure one live engine per actor + surface; concurrent launches share a promise. */
  async ensureSession(
    actorUserId: string,
    userName: string,
    opts?: { readonly forceReplay?: boolean; readonly signal?: AbortSignal },
    surface?: string
  ): Promise<UserSession> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    opts?.signal?.throwIfAborted();
    const transition = this.originTransitions.get(sessionKey);
    const pending = ensureSessionForCurrentProvider({
      actorUserId,
      userName,
      opts,
      surface: chatSurface,
      sessionKey,
      launching: this.launching,
      persistence: this.deps.persistence,
      sessions: this.sessions,
      pendingForcedReplay: this.pendingForcedReplay,
      waitForSelection: () => waitForOriginThreadTransition(this.originTransitions, sessionKey),
      discardSession: (session) =>
        discardChatSession(sessionKey, session, this.sessions, this.deps.revokeMcpToken),
      launchSession: (launchOpts, providerIdentity) =>
        this.launchSession(actorUserId, userName, launchOpts, chatSurface, providerIdentity)
    });
    const session = await waitForChatAdmission(pending, opts?.signal);
    opts?.signal?.throwIfAborted();
    return this.originTransitions.get(sessionKey) === transition
      ? session
      : this.ensureSession(actorUserId, userName, opts, surface);
  }

  private async launchSession(
    actorUserId: string,
    userName: string,
    opts: { readonly forceReplay?: boolean } | undefined,
    surface: ChatSurface,
    providerIdentity: ActiveChatProvider
  ): Promise<UserSession> {
    return launchChatSession({
      actorUserId,
      userName,
      opts,
      surface,
      providerIdentity,
      deps: this.deps,
      sessions: this.sessions,
      sequenceBySession: this.sequenceBySession,
      serverOwnsDrain: this.serverOwnsDrain,
      pollMs: this.pollMs
    });
  }

  /**
   * Submit one user turn: echo it to subscribers, send it to the engine, fan out
   * every new transcript record until the engine reports complete, persist the
   * completed turn, and return the assistant reply.
   */
  async submitTurn(
    actorUserId: string,
    userName: string,
    text: string,
    opts?: {
      readonly attachments?: readonly StoredAttachmentMeta[];
      readonly moduleControl?: string;
    },
    surface?: string
  ): Promise<{
    reply: string;
    userMessageId?: string;
    assistantMessageId?: string;
    sourceFreshness?: SourceFreshnessV1 | null;
  }> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    // Turn-at-a-time (spec §6.5): set synchronously before await, then clear in finally.
    if (this.turnsInFlight.has(sessionKey)) {
      throw new ChatTurnInFlightError();
    }
    this.turnsInFlight.add(sessionKey);
    try {
      return await runChatTurn(this.turnHost, actorUserId, userName, text, opts, chatSurface);
    } finally {
      this.turnsInFlight.delete(sessionKey);
    }
  }

  async seedContext(
    actorUserId: string,
    userName: string,
    seed: string,
    idempotencyKey?: string,
    surface?: string,
    admissionPath: "seed_route" | "evening_seed" = "seed_route"
  ): Promise<void> {
    return seedChatContext({
      actorUserId,
      userName,
      seed,
      admissionPath,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(surface ? { surface } : {}),
      deps: this.deps,
      ensureSession: this.ensureSession.bind(this),
      pollMs: this.pollMs
    });
  }

  /** #456 — stop one in-flight turn for this actor + surface. */
  async stopTurn(actorUserId: string, surface?: string): Promise<void> {
    await stopSessionTurn({
      actorUserId,
      surface: normalizeChatSurface(surface),
      turnControllers: this.turnControllers,
      sessions: this.sessions
    });
  }

  /** /clear drops the live engine; the next turn relaunches from the new thread. */
  async clear(
    actorUserId: string,
    options?: { incognito?: boolean },
    surface?: string
  ): Promise<void> {
    await withOriginThreadTransition(
      this.originTransitions,
      surfaceSessionKey(actorUserId, normalizeChatSurface(surface)),
      () =>
        clearChatSession({
          actorUserId,
          surface,
          options,
          persistence: this.deps.persistence,
          sessions: this.sessions,
          stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface),
          endPrivateSession: (userId, chatSurface) => this.endPrivateSession(userId, chatSurface),
          revokeMcpToken: this.deps.revokeMcpToken,
          pendingForcedReplay: this.pendingForcedReplay
        })
    );
  }

  async endPrivateSession(actorUserId: string, surface?: string): Promise<void> {
    await withOriginThreadTransition(
      this.originTransitions,
      surfaceSessionKey(actorUserId, normalizeChatSurface(surface)),
      () =>
        endPrivateChatSession({
          actorUserId,
          surface,
          persistence: this.deps.persistence,
          sessions: this.sessions,
          deps: this.deps,
          clearDetachTimer: (k) => clearPrivateDetachTimer(this.privateDetachTimers, k),
          stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface)
        })
    );
  }

  async getPrivacyState(
    actorUserId: string,
    surface?: string
  ): Promise<{ readonly incognito: boolean; readonly threadId?: string }> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    const session = this.sessions.get(sessionKey);
    const currentThread = session
      ? { id: session.threadId, incognito: session.incognito }
      : await getSelectedThreadState({
          actorUserId,
          surface: chatSurface,
          useMain: usesMainThreadSelection({
            surface: chatSurface,
            forceReplay: this.pendingForcedReplay.has(sessionKey)
          }),
          persistence: this.deps.persistence
        });
    return {
      incognito: currentThread?.incognito ?? false,
      ...(currentThread?.id ? { threadId: currentThread.id } : {})
    };
  }
  /** Resume an owned thread for this actor + surface. */
  async resumeThread(actorUserId: string, threadId: string, surface?: string): Promise<void> {
    await withOriginThreadTransition(
      this.originTransitions,
      surfaceSessionKey(actorUserId, normalizeChatSurface(surface)),
      () =>
        resumeChatThread({
          actorUserId,
          threadId,
          surface,
          persistence: this.deps.persistence,
          sessions: this.sessions,
          stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface),
          revokeMcpToken: this.deps.revokeMcpToken,
          pendingForcedReplay: this.pendingForcedReplay
        })
    );
  }
  /** Switch provider without resetting the surface's conversation. */
  async switchProvider(actorUserId: string, userName: string, surface?: string): Promise<void> {
    await switchChatProviderSession({
      actorUserId,
      userName,
      surface,
      sessions: this.sessions,
      discardSession: (sessionKey, session) =>
        discardChatSession(sessionKey, session, this.sessions, this.deps.revokeMcpToken),
      ensureSession: (...args) => this.ensureSession(...args)
    });
  }

  /** #1081 — drop live sessions after a provider binary replacement. */
  async dropSessionsForProvider(provider: ProviderKind): Promise<void> {
    await this.withMaintenanceLock(() =>
      dropSessionsForProvider({
        provider,
        sessions: this.sessions,
        revokeMcpToken: this.deps.revokeMcpToken
      })
    );
  }

  /** Register one surface subscriber and return its unsubscribe handle. */
  subscribe(actorUserId: string, fn: Subscriber, surface?: string): () => void {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    clearPrivateDetachTimer(this.privateDetachTimers, sessionKey);
    let set = this.subscribers.get(sessionKey);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionKey, set);
    }
    if (set.size >= MAX_SUBSCRIBERS_PER_ACTOR) {
      throw new ChatStreamLimitError();
    }
    if (this.countSubscribers(actorUserId) >= MAX_SUBSCRIBERS_TOTAL_PER_ACTOR) {
      throw new ChatStreamLimitError();
    }
    set.add(fn);
    return () => {
      const current = this.subscribers.get(sessionKey);
      current?.delete(fn);
      if (current && current.size === 0) {
        this.subscribers.delete(sessionKey);
        if (this.sessions.get(sessionKey)?.incognito) {
          schedulePrivateDetachTimer(this.privateDetachTimers, sessionKey, () =>
            this.endPrivateSession(actorUserId, chatSurface)
          );
        }
      }
    };
  }

  // Non-action notifications may target a surface; actions require injectOriginRecord.
  injectRecord(actorUserId: string, record: TranscriptRecord, surface?: string): void {
    if (record.kind === "action_request" || record.kind === "action_result") return;
    this.emit(actorUserId, normalizeChatSurface(surface), record);
  }

  injectLiveOriginRecord(
    actorUserId: string,
    originThreadId: string,
    record: TranscriptRecord,
    surface: string
  ): boolean {
    return routeLiveOriginRecord({
      ...this.originRoutingState(actorUserId),
      actorUserId,
      originThreadId,
      record,
      surface
    });
  }

  /** #3195: show a stored background message in the owner's open Main drawer, if any. */
  deliverMainBackgroundMessage(message: MainBackgroundMessage): Promise<void> {
    return routeMainBackgroundMessage({
      ...message,
      shown: (actorUserId) => this.getPrivacyState(actorUserId, DEFAULT_CHAT_SURFACE),
      transitions: this.originTransitions,
      emit: (surface, record) => this.emit(message.actorUserId, surface, record)
    });
  }

  injectOriginRecord(
    actorUserId: string,
    originThreadId: string | null | undefined,
    record: TranscriptRecord,
    _surface?: string,
    historyOnly = false
  ): Promise<OriginRecordReceipt> {
    return routeOriginRecord({
      ...this.originRoutingState(actorUserId),
      actorUserId,
      originThreadId,
      record,
      historyOnly
    });
  }

  private originRoutingState(actorUserId: string) {
    return {
      persistence: this.deps.persistence,
      sessions: this.sessions,
      transitions: this.originTransitions,
      turnsInFlight: this.turnsInFlight,
      sequenceBySession: this.sequenceBySession,
      pendingBySession: this.pendingActionResultsBySession,
      turnRecords: this.turnActivityBySession,
      actionResults: this.actionResultsBySession,
      emit: (surface: ChatSurface, next: TranscriptRecord) => this.emit(actorUserId, surface, next)
    };
  }

  /**
   * Kill and drop any engine idle longer than idleMs. The conversation persists,
   * so the next submitTurn respawns the engine and replays prior turns.
   *
   * Runs under the shared §5.4 maintenance mutex so it can never race the ONE
   * reconciliation routine (both mutate `sessions` + revoke tokens).
   */
  async reapIdle(): Promise<void> {
    await this.withMaintenanceLock(async () => {
      const now = this.deps.clock.now();
      for (const [sessionKey, session] of this.sessions) {
        if (session.incognito && (this.subscribers.get(sessionKey)?.size ?? 0) > 0) {
          continue;
        }
        if (now - session.lastActivity > this.deps.idleMs) {
          if (session.incognito) {
            await this.endPrivateSession(session.actorUserId, session.surface);
            continue;
          }
          await session.engine.kill();
          this.sessions.delete(sessionKey);
          this.deps.revokeMcpToken?.(sessionKey);
        }
      }
    });
  }

  /**
   * The ONE authoritative reconciliation (#342, RPC contract §5.3). Driven by the RPC
   * client on every socket (re)connect AND on a detected cli-runner `bootId` change (§5.6).
   * `liveKeys` is the authoritative set of sessionKeys the cli-runner reports alive (via
   * `listLiveSessions`, enumerated by mux — §4.6). After it returns, the api's token
   * registry and `sessions` map are consistent with the cli-runner's live set.
   *
   * In-flight launch keys are unioned into `liveKeys` so reconcile never kills
   * a session the api is itself bringing up.
   */
  async reconcileLiveSessions(liveKeys: Set<string>): Promise<void> {
    await this.withMaintenanceLock(() =>
      reconcileChatSessions(liveKeys, {
        launching: this.launching,
        sessions: this.sessions,
        deps: this.deps,
        clearPrivateDetachTimer: (key) => clearPrivateDetachTimer(this.privateDetachTimers, key)
      })
    );
  }

  /** #1554 Decision 2 — api-side half of a `sessionReaped` push; see `applyRemoteReap`. */
  async handleRemoteReap(sessionKey: string, _reason: ReapReason): Promise<void> {
    await this.withMaintenanceLock(async () =>
      applyRemoteReap(this.sessions, this.deps.revokeMcpToken, sessionKey)
    );
  }

  /** Wire the production idle reaper. Returns a stop handle that clears the interval. */
  startIdleReaper(intervalMs: number = this.deps.idleMs): () => void {
    const handle = setInterval(() => {
      // Swallow errors so a transient reap failure (e.g. a kill RPC blip) does not crash the
      // timer; the next tick retries and the TTL backstop is the final safety net.
      void this.reapIdle().catch(() => {});
    }, intervalMs);
    // Do not keep the event loop alive solely for the reaper (lets the process exit cleanly).
    handle.unref?.();
    return () => clearInterval(handle);
  }

  /** Serialize reconciliation and idle reaping under the shared §5.4 maintenance promise chain. */
  private withMaintenanceLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.maintenanceMutex.then(fn, fn);
    // Keep the chain alive even if this critical section rejects (swallow only on the chain,
    // not for the caller — the caller still sees the original rejection via `run`).
    this.maintenanceMutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private emit(actorUserId: string, surface: ChatSurface, record: TranscriptRecord): void {
    const set = this.subscribers.get(surfaceSessionKey(actorUserId, surface));
    if (!set) return;
    for (const fn of set) fn(record);
  }

  private countSubscribers(actorUserId: string): number {
    return countSubscribersFor(this.subscribers, actorUserId);
  }
}
