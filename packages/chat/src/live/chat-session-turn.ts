import { randomUUID } from "node:crypto";

import { recordModelActivity } from "@moss/ai";
import type { AnswerProvenanceMetadataV1, ChatTurnUsageDto, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import { answerDetailSteps } from "./activity-detail-steps.js";
import { finalizeProvenance, parseAnswerMarkers } from "./answer-provenance.js";
import { renderAttachmentsManifest } from "./attachments-manifest.js";
import { beginClassifierGateShadowTurn } from "./classifier-gate-shadow.js";
import { admissionForActor, admitToContext, submitPreparedTurn } from "./context-admission.js";
import { openLiveTurnRecord, type LiveTurnRecord } from "./live-turn-record.js";
import { buildEngineText } from "./engine-text.js";
import { snapshotMainReminders } from "./main-reminder-context.js";
import {
  assertProviderIdentityForPendingTurn,
  type EnsureSessionOpts,
  type UserSession
} from "./chat-session-provider-identity.js";
import type { ChatSessionManagerDeps } from "./chat-session-ports.js";
import { rollOverSessionIfDue } from "./chat-session-rollover.js";
import {
  noteSessionOutput,
  noteSessionSubmission,
  noteSessionTurnUsage
} from "./chat-session-usage.js";
import { DEFAULT_CHAT_SURFACE, surfaceSessionKey, type ChatSurface } from "./chat-surface.js";
import {
  mapChatEngineReadError,
  CliChatDeliveryUnknownError,
  CHAT_CHANGED_WHILE_STARTING_MESSAGE,
  CliChatUnavailableError,
  ApiKeyLiveChatUnavailableError,
  UnsupportedLegacyCliProviderError
} from "./errors.js";
import {
  waitForChatAdmission,
  waitForOriginThreadTransition,
  type OriginThreadTransition
} from "./origin-record-routing.js";
import { tryPreModelTurn } from "./pre-model-turn.js";
import {
  assertNewToolsAttached,
  createPendingActionResultFlusher,
  delay,
  healAndRelaunchSession,
  upsertActivityRecord,
  type PendingActionResult,
  type SessionRecoveryHost
} from "./session-runtime-helpers.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";

/** Manager state one chat turn reads and updates. */
export interface ChatTurnHost {
  readonly deps: ChatSessionManagerDeps;
  readonly sessions: Map<string, UserSession>;
  readonly originTransitions: Map<string, OriginThreadTransition>;
  readonly pendingForcedReplay: Set<string>;
  readonly turnControllers: Map<string, AbortController>;
  readonly actionResultsBySession: Map<string, ActionResultMetadata[]>;
  readonly turnActivityBySession: Map<string, TranscriptRecord[]>;
  readonly sequenceBySession: Map<string, number>;
  readonly pendingActionResultsBySession: Map<string, PendingActionResult[]>;
  readonly pollMs: number;
  readonly idleWatchdogMs: number;
  readonly lifecycleHost: SessionRecoveryHost;
  emit(actorUserId: string, surface: ChatSurface, record: TranscriptRecord): void;
  ensureSession(
    actorUserId: string,
    userName: string,
    opts?: EnsureSessionOpts & { readonly signal?: AbortSignal },
    surface?: string
  ): Promise<UserSession>;
}

/**
 * Run one accepted user turn: echo it to subscribers, send it to the engine, fan out
 * every new transcript record until the engine reports complete, persist the
 * completed turn, and return the assistant reply.
 */
export async function runChatTurn(
  host: ChatTurnHost,
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
  host.deps.setCurrentTurnId?.(sessionKey, turnId);
  const controller = new AbortController();
  const ensureOpts = { signal: controller.signal };
  host.turnControllers.set(sessionKey, controller);
  host.actionResultsBySession.set(sessionKey, []);
  const turnActivityRecords: TranscriptRecord[] = [];
  host.turnActivityBySession.set(sessionKey, turnActivityRecords);
  let lastDeliveredSequence = 0;
  const flushPendingInOrder = createPendingActionResultFlusher(
    host.pendingActionResultsBySession,
    actorUserId,
    surface,
    sessionKey,
    host.sequenceBySession,
    turnActivityRecords,
    host.actionResultsBySession.get(sessionKey),
    (userId, chatSurface, next) => host.emit(userId, chatSurface, next)
  );
  const flushPending = (beforeSequence?: number) => {
    lastDeliveredSequence = flushPendingInOrder(lastDeliveredSequence, beforeSequence);
  };
  const flushActions = async () => {
    await host.deps.flushActionRecords?.(sessionKey);
    flushPending();
    return {
      activityRecords: turnActivityRecords,
      actionResults: host.actionResultsBySession.get(sessionKey)
    };
  };
  // #1157: a failed launch (dead tmux server, stale daemon state) gets one retry before surfacing.
  let session: UserSession;
  let turnElapsedMs: number | undefined;
  let turnUsage: ChatTurnUsageDto | undefined;
  // #2907 (plan 3.5) — the turn's shadow tracker; created once its own session is resolved.
  let gateShadow: ReturnType<typeof beginClassifierGateShadowTurn> | undefined;
  // #3128: the in-flight record, settled in the finally unless the turn saved.
  let liveTurn: LiveTurnRecord | undefined;
  try {
    await waitForOriginThreadTransition(host.originTransitions, sessionKey, controller.signal);
    if (controller.signal.aborted)
      return finishRefusedTurn(host, actorUserId, surface, sessionKey, undefined, undefined);
    // #2901: the gate may handle the turn before engine launch; decline keeps the model path.
    // #2934 — the gate captures this turn's privacy before its mode wait and returns it.
    const {
      result: gated,
      requestIncognito,
      requestThreadId
    } = await tryPreModelTurn(
      host.lifecycleHost,
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
      return finishRefusedTurn(host, actorUserId, surface, sessionKey, undefined, undefined);
    try {
      session = await host.ensureSession(actorUserId, userName, ensureOpts, surface);
    } catch (err) {
      if (
        !(err instanceof CliChatUnavailableError) ||
        err instanceof ApiKeyLiveChatUnavailableError ||
        err instanceof UnsupportedLegacyCliProviderError
      ) {
        throw err;
      }
      host.pendingForcedReplay.add(sessionKey);
      session = await host.ensureSession(actorUserId, userName, ensureOpts, surface);
    }
    // Refuse another conversation's model, including a same-privacy resume during the mode wait.
    if (
      session.incognito !== requestIncognito ||
      (requestThreadId !== null && session.threadId !== requestThreadId)
    )
      return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
    const turnProviderIdentity = session.providerIdentity;
    gateShadow = beginClassifierGateShadowTurn(
      host.deps.classifierGateShadow,
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
      admissionForActor(host.deps.conversationProvenance, actorUserId),
      session.threadId,
      "module_control_context",
      opts?.moduleControl ?? ""
    );
    const mainReminders = await snapshotMainReminders(
      host.deps,
      actorUserId,
      surface,
      session,
      opts?.moduleControl
    );
    const engineText = await buildEngineText(
      {
        persistence: host.deps.persistence,
        conversationProvenance: host.deps.conversationProvenance,
        passiveRetrieval: host.deps.passiveRetrieval,
        notesRetrieval: host.deps.notesRetrieval,
        crossToolRead: host.deps.crossToolRead,
        priorityModel: host.deps.priorityModel,
        now: host.deps.now
      },
      actorUserId,
      text,
      surface,
      { threadId: session.threadId, chatSessionId: sessionKey },
      {
        attachmentManifest: renderAttachmentsManifest(attachments),
        moduleControl,
        mainReminders: mainReminders.context
      }
    );
    const { pendingItems } = engineText;
    const currentProvider = await host.deps.persistence.resolveActiveProvider(actorUserId);
    await assertProviderIdentityForPendingTurn(turnProviderIdentity, currentProvider);
    host.emit(actorUserId, surface, { kind: "user", text });
    // #3157 — an over-budget session hands off to a fresh one for this exact conversation.
    const servingThreadId = session.threadId;
    let rollover: Awaited<ReturnType<typeof rollOverSessionIfDue>>;
    try {
      rollover = await rollOverSessionIfDue(host, {
        actorUserId,
        userName,
        session,
        nextTurnText: engineText.text,
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted)
        return finishRefusedTurn(host, actorUserId, surface, sessionKey, undefined, gateShadow);
      throw err;
    }
    session = rollover.session;
    if (rollover.waited) {
      if (controller.signal.aborted)
        return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
      if (session.incognito !== requestIncognito || session.threadId !== servingThreadId)
        throw new CliChatUnavailableError(CHAT_CHANGED_WHILE_STARTING_MESSAGE);
      await assertProviderIdentityForPendingTurn(turnProviderIdentity, session.providerIdentity);
      await assertProviderIdentityForPendingTurn(
        turnProviderIdentity,
        host.deps.persistence.resolveActiveProvider(actorUserId)
      );
    }
    let toolsListBaseline = session.mcpToken
      ? host.deps.getToolsListObservationCount?.(session.mcpToken)
      : undefined;
    // #2934 finding 1 — stop before the submit so flipped-thread text never reaches the model.
    if (controller.signal.aborted)
      return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
    liveTurn = await openLiveTurnRecord(host.deps.persistence, actorUserId, session, {
      turnId,
      userText: text,
      attachments
    });
    try {
      await submitPreparedTurn(session.engine, engineText);
      noteSessionSubmission(session.usage, engineText.text, "turn");
    } catch (err) {
      // #2934 finding 1 — a stop around a failed submit refuses instead of resubmitting.
      if (controller.signal.aborted)
        return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
      if (err instanceof CliChatDeliveryUnknownError) {
        // Delivery MAY have happened — never resubmit (duplicate-turn risk); evict so the
        // next turn relaunches cleanly (pre-#1157 behavior, kept).
        if (host.sessions.get(sessionKey) === session) host.sessions.delete(sessionKey);
        host.deps.revokeMcpToken?.(sessionKey);
        throw err;
      }
      if (err instanceof CliChatUnavailableError) {
        // #1157: verified pre-entry failure permits one heal and resubmit.
        await assertProviderIdentityForPendingTurn(
          turnProviderIdentity,
          host.deps.persistence.resolveActiveProvider(actorUserId)
        );
        controller.signal.throwIfAborted();
        const recovery = healAndRelaunchSession(host.lifecycleHost, actorUserId, userName, session);
        session = await waitForChatAdmission(recovery, controller.signal);
        // A new chat inside the heal: re-check stop, identity and privacy before resubmit.
        if (controller.signal.aborted)
          return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
        if (
          session.incognito !== requestIncognito ||
          (requestThreadId !== null && session.threadId !== requestThreadId)
        )
          return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);
        await assertProviderIdentityForPendingTurn(turnProviderIdentity, session.providerIdentity);
        toolsListBaseline = session.mcpToken // #2164 r21 — recapture against the fresh token
          ? host.deps.getToolsListObservationCount?.(session.mcpToken)
          : undefined;
        await submitPreparedTurn(session.engine, engineText);
        noteSessionSubmission(session.usage, engineText.text, "turn");
      } else {
        throw err;
      }
    }

    let reply = "";
    const invokedToolNames = new Set<string>();
    // #2164 r21 correction — correlates mcp__ calls with rejections across readNew polls.
    const mcpAttempts: { readonly name: string; readonly id?: string }[] = [];
    const rejectedCallIds = new Set<string>();
    let lastEmissionAt = host.deps.clock.now();
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
        lastEmissionAt = host.deps.clock.now();
        // #456 — signal activity so the in-flight RPC turn-verb deadline resets (a wedged
        // cli-runner still trips it; an actively-producing turn never does).
        session.engine.resetActivityDeadline?.();
      }
      for (const record of records) {
        noteSessionOutput(session.usage, record);
        if (record.sequence !== undefined) flushPending(record.sequence);
        const rejectionOnly = record.kind === "tool" && !record.toolName && !record.text?.trim();
        if (!rejectionOnly) {
          host.emit(actorUserId, surface, record);
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
      if (host.idleWatchdogMs > 0 && host.deps.clock.now() - lastEmissionAt > host.idleWatchdogMs) {
        watchdogTripped = true;
        break;
      }
      if (host.pollMs > 0) await delay(host.pollMs);
    }
    noteSessionTurnUsage(session.usage, turnUsage);

    if (stopped) {
      // Stopped turns emit status and discard the user message and any partial reply.
      host.emit(actorUserId, surface, { kind: "status", text: "Stopped by user." });
      gateShadow?.cancel();
      session.lastActivity = host.deps.clock.now();
      host.deps.touchMcpToken?.(sessionKey);
      return { reply };
    }

    if (watchdogTripped) {
      liveTurn?.interrupted();
      const seconds = Math.round(host.idleWatchdogMs / 1000);
      host.emit(actorUserId, surface, {
        kind: "status",
        text: `No response from the model for ${seconds} seconds — ending turn.`
      });
      session.lastActivity = host.deps.clock.now();
      host.deps.touchMcpToken?.(sessionKey);
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
      getToolsListObservationCount: host.deps.getToolsListObservationCount,
      now: () => host.deps.clock.now(),
      engine: session.engine,
      emitUnavailable: () =>
        host.emit(actorUserId, surface, {
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
      return finishRefusedTurn(host, actorUserId, surface, sessionKey, session, gateShadow);

    const stored = await host.deps.persistence.recordTurn(
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
        actionResults: host.actionResultsBySession.get(sessionKey),
        activityRecords: turnActivityRecords,
        elapsedMs: turnElapsedMs,
        usage: turnUsage,
        ...(mainReminders.messageIds.length > 0
          ? { acknowledgeReminderMessageIds: mainReminders.messageIds }
          : {}),
        turnId
      },
      surface
    );
    if (stored !== undefined) liveTurn?.saved();
    session.lastActivity = host.deps.clock.now();
    host.deps.touchMcpToken?.(sessionKey);

    // #2956: only stored turns get an answer line for later agreement and tool-count joins.
    if (stored) {
      recordAnswerLine(actorUserId, turnId, {
        modelName: session.model,
        durationMs: turnElapsedMs,
        usage: turnUsage,
        toolNames: invokedToolNames,
        actionResults: host.actionResultsBySession.get(sessionKey),
        quote: text,
        records: turnActivityRecords,
        reply
      });
    }

    // Post-store: re-emit reply with messageId + sourceFreshness so live UI picks it up
    if (stored?.assistantMessageId && stored.sourceFreshness !== undefined) {
      host.emit(actorUserId, surface, {
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
    if (!controller.signal.aborted) liveTurn?.interrupted();
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
    return finishRefusedTurn(host, actorUserId, surface, sessionKey, undefined, gateShadow);
  } finally {
    await liveTurn?.settle();
    // #2907 — record a no-model-tool turn distinctly. A recorded cancel outranks this in the runner.
    gateShadow?.finish();
    // #2956: release the filing slot so later tool calls cannot join this turn.
    host.deps.clearCurrentTurnId?.(sessionKey);
    flushPending();
    host.turnActivityBySession.delete(sessionKey);
    host.actionResultsBySession.delete(sessionKey);
    host.pendingActionResultsBySession.delete(sessionKey);
    host.sequenceBySession.delete(sessionKey);
    host.turnControllers.delete(sessionKey);
  }
}

/** #2956: record each completed answer in the owner's scope without blocking the turn. */
function recordAnswerLine(
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
function finishRefusedTurn(
  host: ChatTurnHost,
  actorUserId: string,
  surface: ChatSurface,
  sessionKey: string,
  session: UserSession | undefined,
  gateShadow: ReturnType<typeof beginClassifierGateShadowTurn> | undefined
): { reply: string } {
  host.emit(actorUserId, surface, { kind: "status", text: "Stopped by user." });
  gateShadow?.cancel();
  if (session) {
    session.lastActivity = host.deps.clock.now();
    host.deps.touchMcpToken?.(sessionKey);
  }
  return { reply: "" };
}
