import { randomUUID } from "node:crypto";

import { recordModelActivity, type ProviderKind } from "@moss/ai";
import type { ActivityDetailStep } from "@moss/db";
import type { AnswerProvenanceMetadataV1, ChatTurnUsageDto, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import { finalizeProvenance, parseAnswerMarkers } from "./answer-provenance.js";
import { renderAttachmentsManifest } from "./attachments-manifest.js";
import { buildEngineText } from "./engine-text.js";
import {
  assertProviderIdentityForPendingTurn,
  discardChatSession,
  dropSessionsForProvider,
  ensureSessionForCurrentProvider,
  switchChatProviderSession,
  type ActiveChatProvider,
  type UserSession
} from "./chat-session-provider-identity.js";
import { launchChatSession, seedChatContext } from "./chat-session-launch.js";
import {
  ChatStreamLimitError,
  ChatTurnInFlightError,
  mapChatEngineReadError,
  CliChatDeliveryUnknownError,
  CliChatUnavailableError,
  ApiKeyLiveChatUnavailableError,
  UnsupportedLegacyCliProviderError
} from "./errors.js";
import { beginClassifierGateShadowTurn } from "./classifier-gate-shadow.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";
import type { ReapReason } from "./provider-runtime.js";
import {
  applyRemoteReap,
  cleanupPrivateSession,
  clearChatSession,
  countSubscribersFor,
  delay,
  createPendingActionResultFlusher,
  clearPrivateDetachTimer,
  endPrivateChatSession,
  healAndRelaunchSession,
  resumeChatThread,
  stopSessionTurn,
  injectActionResultRecord,
  type PendingActionResult,
  type SessionRecoveryHost,
  schedulePrivateDetachTimer,
  sweepOrphanedPrivateThreads,
  upsertActivityRecord,
  assertNewToolsAttached
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
import { tryGatedTurn } from "./classifier-gate-lifecycle.js";
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
  }

  /** Ensure one live engine per actor + surface; concurrent launches share a promise. */
  async ensureSession(
    actorUserId: string,
    userName: string,
    opts?: { readonly forceReplay?: boolean },
    surface?: string
  ): Promise<UserSession> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    return ensureSessionForCurrentProvider({
      actorUserId,
      userName,
      opts,
      surface: chatSurface,
      sessionKey,
      launching: this.launching,
      persistence: this.deps.persistence,
      sessions: this.sessions,
      pendingForcedReplay: this.pendingForcedReplay,
      discardSession: (session) =>
        discardChatSession(sessionKey, session, this.sessions, this.deps.revokeMcpToken),
      launchSession: (launchOpts, providerIdentity) =>
        this.launchSession(actorUserId, userName, launchOpts, chatSurface, providerIdentity)
    });
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
    // Turn-at-a-time (spec §6.5): reject a concurrent turn for the same surface.
    // The flag is set synchronously (before any await) so two turns started in
    // the same tick can't both pass the check, and cleared in finally below.
    if (this.turnsInFlight.has(sessionKey)) {
      throw new ChatTurnInFlightError();
    }
    this.turnsInFlight.add(sessionKey);
    try {
      return await this.runTurn(actorUserId, userName, text, opts, chatSurface);
    } finally {
      this.turnsInFlight.delete(sessionKey);
    }
  }

  async seedContext(
    actorUserId: string,
    userName: string,
    seed: string,
    idempotencyKey?: string,
    surface?: string
  ): Promise<void> {
    return seedChatContext({
      actorUserId,
      userName,
      seed,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(surface ? { surface } : {}),
      deps: this.deps,
      ensureSession: this.ensureSession.bind(this),
      pollMs: this.pollMs
    });
  }

  private async runTurn(
    actorUserId: string,
    userName: string,
    text: string,
    opts?: {
      readonly attachments?: readonly StoredAttachmentMeta[];
      readonly moduleControl?: string;
    },
    surface: ChatSurface = DEFAULT_CHAT_SURFACE
  ): Promise<{
    reply: string;
    userMessageId?: string;
    assistantMessageId?: string;
    sourceFreshness?: SourceFreshnessV1 | null;
  }> {
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    // #2956: one id for the turn, the shadow record, the audit rows and the
    // answer line. Minted once here, so a launch retry or a replayed submit in
    // this same turn reuses it and the answer line is written exactly once.
    const turnId = randomUUID();
    // File this session's tool rows under the turn; cleared in the finally below.
    this.deps.setCurrentTurnId?.(sessionKey, turnId);
    const controller = new AbortController();
    this.turnControllers.set(sessionKey, controller);
    this.actionResultsBySession.set(sessionKey, []);
    const turnActivityRecords: TranscriptRecord[] = [];
    this.turnActivityBySession.set(sessionKey, turnActivityRecords);
    let lastDeliveredSequence = 0;
    const flushPendingInOrder = createPendingActionResultFlusher(
      this.pendingActionResultsBySession,
      actorUserId,
      surface,
      sessionKey,
      this.sequenceBySession,
      turnActivityRecords,
      this.actionResultsBySession.get(sessionKey),
      (userId, chatSurface, next) => this.emit(userId, chatSurface, next)
    );
    const flushPending = (beforeSequence?: number) => {
      lastDeliveredSequence = flushPendingInOrder(lastDeliveredSequence, beforeSequence);
    };
    // #1157: a failed launch (dead tmux server, stale daemon state) gets one retry before surfacing.
    let session: UserSession;
    let turnElapsedMs: number | undefined;
    let turnUsage: ChatTurnUsageDto | undefined;
    // #2907 (plan 3.5) — the turn's shadow tracker; created once its own session is resolved.
    let gateShadow: ReturnType<typeof beginClassifierGateShadowTurn> | undefined;
    try {
      // Task 4.1 (#2901) — the classifier gate runs before any engine launch (`on` only). A
      // handled turn returns here; a decline falls through to the default model path unchanged.
      // #2934 — the gate captures this turn's privacy before its mode wait and returns it.
      const { result: gated, requestIncognito } = await tryGatedTurn(
        this.lifecycleHost,
        actorUserId,
        surface,
        text,
        { ...opts, turnId, parentId: turnId },
        controller
      );
      if (gated) return gated;
      // #2934 finding 1 — a stop during the gate attempt stops the turn pre-emit.
      if (controller.signal.aborted)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, undefined, undefined);
      try {
        session = await this.ensureSession(actorUserId, userName, undefined, surface);
      } catch (err) {
        if (
          !(err instanceof CliChatUnavailableError) ||
          err instanceof ApiKeyLiveChatUnavailableError ||
          err instanceof UnsupportedLegacyCliProviderError
        ) {
          throw err;
        }
        this.pendingForcedReplay.add(sessionKey);
        session = await this.ensureSession(actorUserId, userName, undefined, surface);
      }
      // #2934 finding 1 — fail closed on privacy mismatch: refuse another thread's model.
      if (session.incognito !== requestIncognito)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
      const turnProviderIdentity = session.providerIdentity;
      gateShadow = beginClassifierGateShadowTurn(
        this.deps.classifierGateShadow,
        actorUserId,
        surface,
        text,
        // #2934 — the turn's own privacy, not the session resolved after the wait.
        requestIncognito,
        {
          hasAttachment: (opts?.attachments?.length ?? 0) > 0,
          signal: controller.signal,
          // #2956: the shadow record shares the turn-start id.
          turnId
        }
      );

      const attachments = opts?.attachments ?? [];
      const { text: builtEngineText, pendingItems } = await buildEngineText(
        {
          persistence: this.deps.persistence,
          passiveRetrieval: this.deps.passiveRetrieval,
          notesRetrieval: this.deps.notesRetrieval,
          crossToolRead: this.deps.crossToolRead,
          priorityModel: this.deps.priorityModel,
          now: this.deps.now
        },
        actorUserId,
        text,
        surface
      );
      // #1133 — attachments ride as a server-composed manifest appended AFTER all user text.
      const manifest = renderAttachmentsManifest(attachments);
      const withAttachments = manifest ? `${builtEngineText}\n\n${manifest}` : builtEngineText;
      const engineText = opts?.moduleControl
        ? `${withAttachments}\n\n${opts.moduleControl}`
        : withAttachments;
      const currentProvider = await this.deps.persistence.resolveActiveProvider(actorUserId);
      await assertProviderIdentityForPendingTurn(turnProviderIdentity, currentProvider);
      this.emit(actorUserId, surface, { kind: "user", text });
      let toolsListBaseline = session.mcpToken
        ? this.deps.getToolsListObservationCount?.(session.mcpToken)
        : undefined;
      // #2934 finding 1 — stop before the submit so flipped-thread text never reaches the model.
      if (controller.signal.aborted)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
      try {
        await session.engine.submit(engineText);
      } catch (err) {
        // #2934 finding 1 — a stop around a failed submit refuses instead of resubmitting.
        if (controller.signal.aborted)
          return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
        if (err instanceof CliChatDeliveryUnknownError) {
          // Delivery MAY have happened — never resubmit (duplicate-turn risk); evict so the
          // next turn relaunches cleanly (pre-#1157 behavior, kept).
          if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
          this.deps.revokeMcpToken?.(sessionKey);
          throw err;
        }
        if (err instanceof CliChatUnavailableError) {
          // #1157: unavailable = the text verifiably never entered the engine (paste failed
          // pre-entry, or the daemon has no live session). Safe to heal + resubmit ONCE.
          await assertProviderIdentityForPendingTurn(
            turnProviderIdentity,
            this.deps.persistence.resolveActiveProvider(actorUserId)
          );
          session = await healAndRelaunchSession(
            this.lifecycleHost,
            actorUserId,
            userName,
            session
          );
          // #2934 round 2 — a new chat inside the heal: re-check stop and privacy before resubmit.
          if (controller.signal.aborted)
            return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
          if (session.incognito !== requestIncognito)
            return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
          await assertProviderIdentityForPendingTurn(
            turnProviderIdentity,
            session.providerIdentity
          );
          toolsListBaseline = session.mcpToken // #2164 r21 — recapture against the fresh token
            ? this.deps.getToolsListObservationCount?.(session.mcpToken)
            : undefined;
          await session.engine.submit(engineText);
        } else {
          throw err;
        }
      }

      let reply = "";
      const invokedToolNames = new Set<string>();
      // #2164 r21 correction — correlates mcp__ calls with rejections across readNew polls.
      const mcpAttempts: { readonly name: string; readonly id?: string }[] = [];
      const rejectedCallIds = new Set<string>();
      let lastEmissionAt = this.deps.clock.now();
      let watchdogTripped = false;
      let stopped = false;
      for (;;) {
        let records: TranscriptRecord[];
        let offset: number;
        let complete: boolean;
        try {
          const result = await session.engine.readNew(session.transcriptOffset);
          records = result.records;
          offset = result.offset;
          complete = result.complete;
        } catch (error) {
          // #456 — a killed engine rejects readNew; stop exits cleanly, other failures surface.
          if (controller.signal.aborted) {
            stopped = true;
            break;
          }
          flushPending();
          throw mapChatEngineReadError(session.provider, error);
        }
        if (controller.signal.aborted) {
          stopped = true;
          break;
        }
        session.transcriptOffset = offset;
        if (records.length > 0) {
          lastEmissionAt = this.deps.clock.now();
          // #456 — signal activity so the in-flight RPC turn-verb deadline resets (a wedged
          // cli-runner still trips it; an actively-producing turn never does).
          session.engine.resetActivityDeadline?.();
        }
        for (const record of records) {
          if (record.sequence !== undefined) flushPending(record.sequence);
          const rejectionOnly = record.kind === "tool" && !record.toolName && !record.text?.trim();
          if (!rejectionOnly) {
            this.emit(actorUserId, surface, record);
            if (record.kind !== "reply" && record.kind !== "status") {
              upsertActivityRecord(turnActivityRecords, record);
            }
          }
          if (record.kind === "reply") {
            reply = record.text;
            if (record.elapsedMs !== undefined) turnElapsedMs = record.elapsedMs;
            if (record.usage !== undefined) turnUsage = record.usage;
          }
          if (record.kind === "tool" && record.toolName) {
            invokedToolNames.add(record.toolName);
            if (record.toolName.startsWith("mcp__"))
              mcpAttempts.push({ name: record.toolName, id: record.toolCallId });
            if (!record.rejected) gateShadow?.noteTool(record.toolName);
          }
          if (record.kind === "tool" && record.rejected && record.toolCallId)
            rejectedCallIds.add(record.toolCallId);
          if (record.sequence !== undefined) {
            lastDeliveredSequence = Math.max(lastDeliveredSequence, record.sequence);
          }
        }
        if (complete) {
          flushPending();
          break;
        }
        flushPending(lastDeliveredSequence + 2);
        // #456 — user-driven Stop exits cleanly so the turn lock releases; persist nothing.
        if (controller.signal.aborted) {
          stopped = true;
          break;
        }
        // #456 — idle watchdog ends only after a full quiet window; active output resets it.
        if (
          this.idleWatchdogMs > 0 &&
          this.deps.clock.now() - lastEmissionAt > this.idleWatchdogMs
        ) {
          watchdogTripped = true;
          break;
        }
        if (this.pollMs > 0) await delay(this.pollMs);
      }

      if (stopped) {
        // Coordinator ruling (a): emit a status record over SSE, persist NOTHING. The user message
        // and any partial reply are discarded — the turn never completed.
        this.emit(actorUserId, surface, { kind: "status", text: "Stopped by user." });
        gateShadow?.cancel();
        session.lastActivity = this.deps.clock.now();
        this.deps.touchMcpToken?.(sessionKey);
        return { reply };
      }

      if (watchdogTripped) {
        const seconds = Math.round(this.idleWatchdogMs / 1000);
        this.emit(actorUserId, surface, {
          kind: "status",
          text: `No response from the model for ${seconds} seconds — ending turn.`
        });
        session.lastActivity = this.deps.clock.now();
        this.deps.touchMcpToken?.(sessionKey);
        return { reply };
      }
      // #2164: per-turn engines need a fresh attach; only successful identified calls satisfy the gate.
      await assertNewToolsAttached({
        startsToolClientPerTurn: session.startsToolClientPerTurn,
        provider: session.provider,
        mcpToken: session.mcpToken,
        mcpToolInvoked: mcpAttempts.some((a) => a.id != null && !rejectedCallIds.has(a.id)),
        reply,
        toolsListBaseline,
        getToolsListObservationCount: this.deps.getToolsListObservationCount,
        now: () => this.deps.clock.now(),
        engine: session.engine,
        emitUnavailable: () =>
          this.emit(actorUserId, surface, {
            kind: "status",
            text: "Chat tools were not available for this reply — please try again."
          })
      });

      let answerProvenance: AnswerProvenanceMetadataV1 | undefined;
      if (pendingItems.length > 0 && reply) {
        try {
          const citedIds = parseAnswerMarkers(reply);
          answerProvenance = finalizeProvenance(pendingItems, citedIds);
        } catch {
          answerProvenance = undefined;
        }
      }

      // #2934 — a stop after the read loop still stops the save under a flipped thread.
      if (controller.signal.aborted)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);

      const stored = await this.deps.persistence.recordTurn(
        actorUserId,
        text,
        reply,
        {
          provider: session.provider,
          model: session.model
        },
        {
          invokedToolNames,
          answerProvenance,
          attachments:
            attachments.length > 0
              ? attachments.map((meta) => ({
                  id: meta.id,
                  fileName: meta.fileName,
                  mimeType: meta.mimeType,
                  sizeBytes: meta.sizeBytes
                }))
              : undefined,
          actionResults: this.actionResultsBySession.get(sessionKey),
          activityRecords: turnActivityRecords,
          elapsedMs: turnElapsedMs,
          usage: turnUsage
        },
        surface
      );
      session.lastActivity = this.deps.clock.now();
      this.deps.touchMcpToken?.(sessionKey);

      // #2956: the turn's answer line, with the turn-start id. Only a stored
      // turn writes one — refused, stopped and private turns persist nothing,
      // so their steps reference a missing parent, by design. Jev agreement
      // settles in the shadow record after this write; the bare line carries
      // tool counts, and agreement attaches to the detail row separately.
      if (stored) {
        this.recordAnswerLine(actorUserId, turnId, {
          modelName: session.model,
          durationMs: turnElapsedMs,
          usage: turnUsage,
          toolNames: invokedToolNames,
          actionResults: this.actionResultsBySession.get(sessionKey),
          quote: text,
          records: turnActivityRecords,
          reply
        });
      }

      // Post-store: re-emit reply with messageId + sourceFreshness so live UI picks it up
      if (stored?.assistantMessageId && stored.sourceFreshness !== undefined) {
        this.emit(actorUserId, surface, {
          kind: "reply",
          text: reply,
          messageId: stored.assistantMessageId,
          sourceFreshness: stored.sourceFreshness,
          ...(turnElapsedMs !== undefined ? { elapsedMs: turnElapsedMs } : {}),
          ...(turnUsage !== undefined ? { usage: turnUsage } : {})
        });
      }

      return {
        reply,
        userMessageId: stored?.userMessageId,
        assistantMessageId: stored?.assistantMessageId,
        sourceFreshness: stored?.sourceFreshness
      };
    } finally {
      // #2907 — record a no-model-tool turn distinctly. A recorded cancel outranks this in the runner.
      gateShadow?.finish();
      // #2956: release the turn's filing slot in the same finally that drops
      // every other per-turn state, so later tool calls cannot join this turn.
      this.deps.clearCurrentTurnId?.(sessionKey);
      flushPending();
      this.turnActivityBySession.delete(sessionKey);
      this.actionResultsBySession.delete(sessionKey);
      this.pendingActionResultsBySession.delete(sessionKey);
      this.sequenceBySession.delete(sessionKey);
      this.turnControllers.delete(sessionKey);
    }
  }

  /**
   * #2956: one owned answer line per completed chat turn. Fire-and-forget like
   * every other writer: the installed recorder routes the owned write through
   * the owner's scope, and a failed write is logged and dropped, never thrown
   * into the turn.
   */
  private recordAnswerLine(
    actorUserId: string,
    turnId: string,
    turn: {
      readonly modelName: string;
      readonly durationMs?: number;
      readonly usage?: ChatTurnUsageDto;
      readonly toolNames: ReadonlySet<string>;
      readonly actionResults?: readonly ActionResultMetadata[];
      readonly quote: string;
      readonly records: readonly TranscriptRecord[];
      readonly reply: string;
    }
  ): void {
    const failed = (turn.actionResults ?? []).filter((r) => r.outcome === "error").length;
    recordModelActivity({
      id: turnId,
      kind: "chat",
      action: "chat",
      outcome: "ok",
      modelName: turn.modelName,
      result: "completed",
      ownerUserId: actorUserId,
      actionCode: "chat.answer",
      turnId,
      ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      ...(turn.usage?.inputTokens !== undefined ? { inputTokens: turn.usage.inputTokens } : {}),
      ...(turn.usage?.outputTokens !== undefined ? { outputTokens: turn.usage.outputTokens } : {}),
      factCounts: { tools: turn.toolNames.size, tools_failed: failed },
      detail: {
        quote: turn.quote,
        steps: answerDetailSteps(turn.records, turn.reply)
      }
    });
  }

  /** #2934 — fail a turn closed before it touches the model or the store. */
  private finishRefusedTurn(
    actorUserId: string,
    surface: ChatSurface,
    sessionKey: string,
    session: UserSession | undefined,
    gateShadow: ReturnType<typeof beginClassifierGateShadowTurn> | undefined
  ): { reply: string } {
    this.emit(actorUserId, surface, { kind: "status", text: "Stopped by user." });
    gateShadow?.cancel();
    if (session) {
      session.lastActivity = this.deps.clock.now();
      this.deps.touchMcpToken?.(sessionKey);
    }
    return { reply: "" };
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
    await clearChatSession({
      actorUserId,
      surface,
      options,
      persistence: this.deps.persistence,
      sessions: this.sessions,
      stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface),
      endPrivateSession: (userId, chatSurface) => this.endPrivateSession(userId, chatSurface),
      revokeMcpToken: this.deps.revokeMcpToken
    });
  }

  async endPrivateSession(actorUserId: string, surface?: string): Promise<void> {
    await endPrivateChatSession({
      actorUserId,
      surface,
      persistence: this.deps.persistence,
      sessions: this.sessions,
      deps: this.deps,
      clearDetachTimer: (k) => clearPrivateDetachTimer(this.privateDetachTimers, k),
      stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface)
    });
  }

  async getPrivacyState(
    actorUserId: string,
    surface?: string
  ): Promise<{ readonly incognito: boolean }> {
    const currentThread = await this.deps.persistence.getCurrentThreadState?.(
      actorUserId,
      normalizeChatSurface(surface)
    );
    return { incognito: currentThread?.incognito ?? false };
  }

  /** Resume an owned thread for this actor + surface. */
  async resumeThread(actorUserId: string, threadId: string, surface?: string): Promise<void> {
    await resumeChatThread({
      actorUserId,
      threadId,
      surface,
      persistence: this.deps.persistence,
      sessions: this.sessions,
      stopTurn: (userId, chatSurface) => this.stopTurn(userId, chatSurface),
      revokeMcpToken: this.deps.revokeMcpToken,
      pendingForcedReplay: this.pendingForcedReplay
    });
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

  /**
   * Inject a synthetic record into the fan-out for the given user. Used by the
   * MCP gateway notifier (Phase 2) to push action_request and action_result
   * records into the live transcript stream without going through the engine.
   */
  injectRecord(actorUserId: string, record: TranscriptRecord, surface?: string): void {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    if (record.kind === "action_result" && record.outcome) {
      const currentSequence = this.sequenceBySession.get(sessionKey) ?? 0;
      if (this.turnsInFlight.has(sessionKey)) {
        const recordSequence = record.sequence ?? currentSequence + 1;
        const approvalSequence = Math.max(currentSequence, recordSequence) + 1;
        this.sequenceBySession.set(sessionKey, approvalSequence);
        let pending = this.pendingActionResultsBySession.get(sessionKey);
        if (!pending) {
          pending = [];
          this.pendingActionResultsBySession.set(sessionKey, pending);
        }
        pending.push({ record, recordSequence, approvalSequence });
        return;
      }
      injectActionResultRecord(record, {
        sessionKey,
        sequenceBySession: this.sequenceBySession,
        turnRecords: this.turnActivityBySession.get(sessionKey),
        actionResults: this.actionResultsBySession.get(sessionKey),
        emit: (next) => this.emit(actorUserId, chatSurface, next)
      });
      return;
    }
    this.emit(actorUserId, chatSurface, record);
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
    await this.withMaintenanceLock(async () => {
      // Treat in-flight launches as live for the entire launch window (§5.4).
      const effectiveLive = new Set(liveKeys);
      for (const key of this.launching.keys()) effectiveLive.add(key);

      this.deps.reconcileMcpTokens?.(effectiveLive);

      for (const [sessionKey, session] of this.sessions) {
        if (!effectiveLive.has(sessionKey)) {
          if (session.incognito) {
            const thread = await this.deps.persistence.getCurrentThreadState?.(
              session.actorUserId,
              session.surface
            );
            await cleanupPrivateSession(
              session.actorUserId,
              session.surface,
              thread?.incognito ? thread.id : undefined,
              session,
              this.deps,
              this.sessions,
              (k) => clearPrivateDetachTimer(this.privateDetachTimers, k)
            );
          } else {
            try {
              if (this.deps.killSession) {
                await this.deps.killSession(sessionKey);
              } else {
                await session.engine.kill();
              }
            } catch {
              /* best-effort stale kill */
            }
            this.sessions.delete(sessionKey);
            this.deps.revokeMcpToken?.(sessionKey);
          }
        }
      }

      const known = new Set<string>(this.sessions.keys());
      for (const key of this.launching.keys()) known.add(key);
      for (const id of this.deps.listMcpTokenSessionIds?.() ?? []) known.add(id);
      for (const liveKey of effectiveLive) {
        if (!known.has(liveKey)) {
          await this.deps.killSession?.(liveKey);
        }
      }
      await sweepOrphanedPrivateThreads(effectiveLive, this.deps, this.sessions, (k) =>
        clearPrivateDetachTimer(this.privateDetachTimers, k)
      );
    });
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

/** #2956: detail steps are bounded twice — few steps, short text. */
const ANSWER_DETAIL_STEP_CAP = 20;
const ANSWER_DETAIL_TEXT_CAP = 300;

function answerStepTitle(record: TranscriptRecord): string {
  if (record.toolName) return record.toolName;
  switch (record.kind) {
    case "thought":
    case "thinking":
      return "Thinking";
    case "result":
      return "Result";
    case "reply":
      return "Answer";
    default:
      return record.kind;
  }
}

/**
 * #2956: the turn's records as detail steps, ending with the answer itself
 * (the live record list excludes replies). Asked-for and returned values stay
 * out: they must come from each tool's declared display fields, which is
 * slice C work. Long turns keep their first steps; the tail is the answer.
 */
function answerDetailSteps(
  records: readonly TranscriptRecord[],
  reply: string
): ActivityDetailStep[] {
  const steps = records.slice(0, ANSWER_DETAIL_STEP_CAP - 1).map((record) => ({
    title: answerStepTitle(record),
    result: record.text.slice(0, ANSWER_DETAIL_TEXT_CAP)
  }));
  if (reply) {
    steps.push({ title: "Answer", result: reply.slice(0, ANSWER_DETAIL_TEXT_CAP) });
  }
  return steps;
}
