import { randomUUID } from "node:crypto";

import { recordModelActivity, type ProviderKind } from "@moss/ai";
import type { AnswerProvenanceMetadataV1, ChatTurnUsageDto, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import { answerDetailSteps } from "./activity-detail-steps.js";
import { finalizeProvenance, parseAnswerMarkers } from "./answer-provenance.js";
import { renderAttachmentsManifest } from "./attachments-manifest.js";
import { admissionForActor, admitToContext, submitPreparedTurn } from "./context-admission.js";
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
  clearChatSession,
  countSubscribersFor,
  delay,
  createPendingActionResultFlusher,
  clearPrivateDetachTimer,
  endPrivateChatSession,
  healAndRelaunchSession,
  resumeChatThread,
  stopSessionTurn,
  type PendingActionResult,
  type SessionRecoveryHost,
  schedulePrivateDetachTimer,
  reconcileChatSessions,
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
import { tryPreModelTurn } from "./pre-model-turn.js";
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
    // #2956: one turn id files shadow, audit and answer rows across launch/replay retries.
    const turnId = randomUUID();
    // File this session's tool rows under the turn; cleared in the finally below.
    this.deps.setCurrentTurnId?.(sessionKey, turnId);
    const controller = new AbortController();
    const ensureOpts = { signal: controller.signal };
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
    const flushActions = async () => {
      await this.deps.flushActionRecords?.(sessionKey);
      flushPending();
      return {
        activityRecords: turnActivityRecords,
        actionResults: this.actionResultsBySession.get(sessionKey)
      };
    };
    // #1157: a failed launch (dead tmux server, stale daemon state) gets one retry before surfacing.
    let session: UserSession;
    let turnElapsedMs: number | undefined;
    let turnUsage: ChatTurnUsageDto | undefined;
    // #2907 (plan 3.5) — the turn's shadow tracker; created once its own session is resolved.
    let gateShadow: ReturnType<typeof beginClassifierGateShadowTurn> | undefined;
    try {
      await waitForOriginThreadTransition(this.originTransitions, sessionKey, controller.signal);
      if (controller.signal.aborted)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, undefined, undefined);
      // #2901: the gate may handle the turn before engine launch; decline keeps the model path.
      // #2934 — the gate captures this turn's privacy before its mode wait and returns it.
      const {
        result: gated,
        requestIncognito,
        requestThreadId
      } = await tryPreModelTurn(
        this.lifecycleHost,
        actorUserId,
        surface,
        text,
        { ...opts, turnId, parentId: turnId },
        controller,
        flushActions
      );
      if (gated) return gated;
      // #2934 finding 1 — a stop during the gate attempt stops the turn pre-emit.
      if (controller.signal.aborted)
        return this.finishRefusedTurn(actorUserId, surface, sessionKey, undefined, undefined);
      try {
        session = await this.ensureSession(actorUserId, userName, ensureOpts, surface);
      } catch (err) {
        if (
          !(err instanceof CliChatUnavailableError) ||
          err instanceof ApiKeyLiveChatUnavailableError ||
          err instanceof UnsupportedLegacyCliProviderError
        ) {
          throw err;
        }
        this.pendingForcedReplay.add(sessionKey);
        session = await this.ensureSession(actorUserId, userName, ensureOpts, surface);
      }
      // Refuse another conversation's model, including a same-privacy resume during the mode wait.
      if (
        session.incognito !== requestIncognito ||
        (requestThreadId !== null && session.threadId !== requestThreadId)
      )
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
          threadId: requestThreadId,
          hasAttachment: (opts?.attachments?.length ?? 0) > 0,
          signal: controller.signal,
          // #2956: the shadow record shares the turn-start id.
          turnId
        }
      );

      const attachments = opts?.attachments ?? [];
      const moduleControl = await admitToContext(
        admissionForActor(this.deps.conversationProvenance, actorUserId),
        session.threadId,
        "module_control_context",
        opts?.moduleControl ?? ""
      );
      const engineText = await buildEngineText(
        {
          persistence: this.deps.persistence,
          conversationProvenance: this.deps.conversationProvenance,
          passiveRetrieval: this.deps.passiveRetrieval,
          notesRetrieval: this.deps.notesRetrieval,
          crossToolRead: this.deps.crossToolRead,
          priorityModel: this.deps.priorityModel,
          now: this.deps.now
        },
        actorUserId,
        text,
        surface,
        { threadId: session.threadId, chatSessionId: sessionKey },
        { attachmentManifest: renderAttachmentsManifest(attachments), moduleControl }
      );
      const { pendingItems } = engineText;
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
        await submitPreparedTurn(session.engine, engineText);
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
          // #1157: verified pre-entry failure permits one heal and resubmit.
          await assertProviderIdentityForPendingTurn(
            turnProviderIdentity,
            this.deps.persistence.resolveActiveProvider(actorUserId)
          );
          controller.signal.throwIfAborted();
          const recovery = healAndRelaunchSession(
            this.lifecycleHost,
            actorUserId,
            userName,
            session
          );
          session = await waitForChatAdmission(recovery, controller.signal);
          // A new chat inside the heal: re-check stop, identity and privacy before resubmit.
          if (controller.signal.aborted)
            return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
          if (
            session.incognito !== requestIncognito ||
            (requestThreadId !== null && session.threadId !== requestThreadId)
          )
            return this.finishRefusedTurn(actorUserId, surface, sessionKey, session, gateShadow);
          await assertProviderIdentityForPendingTurn(
            turnProviderIdentity,
            session.providerIdentity
          );
          toolsListBaseline = session.mcpToken // #2164 r21 — recapture against the fresh token
            ? this.deps.getToolsListObservationCount?.(session.mcpToken)
            : undefined;
          await submitPreparedTurn(session.engine, engineText);
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
        // Stopped turns emit status and discard the user message and any partial reply.
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

      await flushActions();
      // #2934: a stop during reads or notification lookup still prevents the turn save.
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
          threadId: session.threadId,
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

      // #2956: only stored turns get an answer line for later agreement and tool-count joins.
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
    } catch (error) {
      if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
      return this.finishRefusedTurn(actorUserId, surface, sessionKey, undefined, gateShadow);
    } finally {
      // #2907 — record a no-model-tool turn distinctly. A recorded cancel outranks this in the runner.
      gateShadow?.finish();
      // #2956: release the filing slot so later tool calls cannot join this turn.
      this.deps.clearCurrentTurnId?.(sessionKey);
      flushPending();
      this.turnActivityBySession.delete(sessionKey);
      this.actionResultsBySession.delete(sessionKey);
      this.pendingActionResultsBySession.delete(sessionKey);
      this.sequenceBySession.delete(sessionKey);
      this.turnControllers.delete(sessionKey);
    }
  }

  /** #2956: record each completed answer in the owner's scope without blocking the turn. */
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
        steps: answerDetailSteps(turn.records, turn.reply, {
          modelName: turn.modelName,
          durationMs: turn.durationMs
        })
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
