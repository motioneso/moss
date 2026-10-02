import type { ProviderKind } from "@moss/ai";
import { resolveMossEnv } from "@moss/db";
import type { AnswerProvenanceMetadataV1, ChatTurnUsageDto, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import { finalizeProvenance, parseAnswerMarkers } from "./answer-provenance.js";
import { renderAttachmentsManifest } from "./attachments-manifest.js";
import { renderReplayBlock, renderSummaryBlock } from "./chat-context-blocks.js";
import { buildEngineText } from "./engine-text.js";
import {
  assertLiveCliProvider,
  assertProviderIdentityForPendingTurn,
  assertProviderIdentityBeforeReplay,
  discardChatSession,
  dropSessionsForProvider,
  ensureSessionForCurrentProvider,
  switchChatProviderSession,
  type ActiveChatProvider,
  type UserSession
} from "./chat-session-provider-identity.js";
import {
  ChatStreamLimitError,
  ChatThreadNotFoundError,
  ChatTurnInFlightError,
  mapChatEngineReadError,
  CliChatDeliveryUnknownError,
  CliChatUnavailableError,
  ApiKeyLiveChatUnavailableError,
  UnsupportedLegacyCliProviderError
} from "./errors.js";
import { renderPersona } from "./persona.js";
import { beginClassifierGateShadowTurn } from "./classifier-gate-shadow.js";
import { renderMemorySeedBlock } from "./recall-seed.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";
import type { ReapReason } from "./provider-runtime.js";
import {
  applyRemoteReap,
  cleanupPrivateSession,
  countSubscribersFor,
  delay,
  drainEngine,
  createPendingActionResultFlusher,
  clearPrivateDetachTimer,
  healAndRelaunchSession,
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
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    const { provider, model, acpModel, providerConfigId, acpAgentId } = providerIdentity;
    assertLiveCliProvider(providerIdentity);
    let threadState = await this.deps.persistence.getCurrentThreadState?.(actorUserId, surface);
    if (!threadState && this.deps.persistence.getCurrentThreadState) {
      await this.deps.persistence.openNewConversation(actorUserId, undefined, surface);
      threadState = await this.deps.persistence.getCurrentThreadState(actorUserId, surface);
    }
    const persona =
      typeof this.deps.persona === "string"
        ? this.deps.persona
        : await this.deps.persona(actorUserId, userName, surface);
    const { neutralDir, personaPath } = await renderPersona(this.deps.personaFs, {
      sessionKey,
      userName,
      provider,
      baseDir: this.deps.neutralBase,
      persona
    });
    const mcpConfig = await this.deps.mintMcpToken?.(actorUserId, sessionKey);
    if (!this.sequenceBySession.has(sessionKey)) this.sequenceBySession.set(sessionKey, 0);
    const nextSequence = () => {
      const next = (this.sequenceBySession.get(sessionKey) ?? 0) + 1;
      this.sequenceBySession.set(sessionKey, next);
      return next;
    };
    const engine = await this.deps.engineFactory(provider, sessionKey, {
      providerConfigId,
      acpAgentId,
      ...(acpModel ? { acpModel } : {}),
      ...(threadState?.id ? { conversationId: threadState.id, userId: actorUserId } : {}),
      ...(mcpConfig?.token && this.deps.acpPermissionDeciderForToken
        ? { acpPermissionDecider: this.deps.acpPermissionDeciderForToken(mcpConfig.token) }
        : {}),
      nextSequence
    });
    await assertProviderIdentityBeforeReplay({
      actorUserId,
      sessionKey,
      providerIdentity,
      persistence: this.deps.persistence,
      engine,
      revokeMcpToken: this.deps.revokeMcpToken
    });
    // Rebuild replay from live state for every launch; recall precedes conversation replay.
    const recallResult = this.deps.recall ? await this.deps.recall.recall(actorUserId) : null;
    const seedBudgetEnv = resolveMossEnv(process.env, "JARVIS_CHAT_SEED_BUDGET_TOKENS");
    const seedBudget = seedBudgetEnv ? parseInt(seedBudgetEnv, 10) : 1500;
    const memorySeed = recallResult
      ? renderMemorySeedBlock(recallResult.episodicChunks, recallResult.facts, seedBudget)
      : "";
    const { recent: recentTurns, oldSummary } = await this.deps.persistence.listPriorTurns(
      actorUserId,
      { forceReplay: opts?.forceReplay },
      surface
    );
    if (threadState?.incognito && surface !== DEFAULT_CHAT_SURFACE) {
      throw new CliChatUnavailableError("private chat is only available in the drawer");
    }
    if (threadState?.incognito && !engine.purgeTranscripts && !engine.handlesOwnPrivatePurge) {
      throw new CliChatUnavailableError("private session unavailable");
    }
    const replayParts: string[] = [];
    if (memorySeed) replayParts.push(memorySeed);
    if (oldSummary) replayParts.push(renderSummaryBlock(oldSummary));
    if (recentTurns.length > 0) replayParts.push(renderReplayBlock(recentTurns));
    const replayBatch = replayParts.length > 0 ? replayParts.join("\n\n") : undefined;
    const { offset } = await engine.launch({
      neutralDir,
      personaPath,
      personaText: persona,
      replayBatch,
      // #367: launch builders emit `--model` only for a concrete settings override; the
      // `"default"` sentinel omits it so the CLI rides its own interactive/account model.
      model,
      ...(acpModel ? { acpModel } : {}),
      mcpToken: mcpConfig?.token,
      mcpServerUrl: mcpConfig?.mcpServerUrl
    });

    const startsToolClientPerTurn = engine.startsToolClientPerTurn ?? false;
    if (mcpConfig?.token && !startsToolClientPerTurn) {
      const toolsListReady = await this.deps.waitForToolsListReady?.(mcpConfig.token);
      if (toolsListReady === false) {
        // The engine process this launch just started, and the token just minted for it, would
        // otherwise leak: nothing else tracks or reaps either once this throw unwinds the launch.
        try {
          await engine.kill();
        } catch {
          // Best-effort teardown of a process that never finished starting up.
        }
        this.deps.revokeMcpToken?.(sessionKey);
        throw new CliChatUnavailableError("tools list was not ready in time");
      }
    }

    const session: UserSession = {
      actorUserId,
      surface,
      engine,
      provider,
      model,
      providerIdentity,
      lastActivity: this.deps.clock.now(),
      transcriptOffset: offset,
      incognito: threadState?.incognito ?? false,
      seededContextKeys: new Set(),
      mcpToken: mcpConfig?.token,
      startsToolClientPerTurn
    };
    this.sessions.set(sessionKey, session);

    // #342 — only in-process engines need manager-owned replay submit + drain.
    if (replayBatch !== undefined && !this.serverOwnsDrain) {
      await engine.submit(replayBatch);
      // Drain (and discard) so real turn records start from a clean offset.
      session.transcriptOffset = await drainEngine(engine, session.transcriptOffset, this.pollMs);
    }

    return session;
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
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    const session = await this.ensureSession(actorUserId, userName, undefined, chatSurface);
    if (idempotencyKey && session.seededContextKeys.has(idempotencyKey)) return;
    await session.engine.submit(seed);
    session.transcriptOffset = await drainEngine(
      session.engine,
      session.transcriptOffset,
      this.pollMs
    );
    if (idempotencyKey) session.seededContextKeys.add(idempotencyKey);
    session.lastActivity = this.deps.clock.now();
    this.deps.touchMcpToken?.(sessionKey);
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
    // #2907 (plan 3.5) — one shadow attempt alongside the default turn, under the same
    // cancellation. The per-turn bookkeeping lives in the shadow module.
    const gateShadow = beginClassifierGateShadowTurn(
      this.deps.classifierGateShadow,
      actorUserId,
      surface,
      text,
      { hasAttachment: (opts?.attachments?.length ?? 0) > 0, signal: controller.signal }
    );

    try {
      // Task 4.1 (#2901) — the classifier gate is tried before any engine launch. Only `on` is
      // acted on here (`off`/`shadow` fall through; shadow wiring is 3.5). A handled or terminal
      // turn returns without launching an engine; a decline returns undefined and the default
      // model path below runs unchanged with the original text.
      const gated = await tryGatedTurn(
        this.lifecycleHost,
        actorUserId,
        surface,
        text,
        opts,
        controller
      );
      if (gated) return gated;
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
      const turnProviderIdentity = session.providerIdentity;

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
      try {
        await session.engine.submit(engineText);
      } catch (err) {
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
            if (!record.rejected) gateShadow.noteTool(record.toolName);
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
        gateShadow.cancel();
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
      gateShadow.finish();
      flushPending();
      this.turnActivityBySession.delete(sessionKey);
      this.actionResultsBySession.delete(sessionKey);
      this.pendingActionResultsBySession.delete(sessionKey);
      this.sequenceBySession.delete(sessionKey);
      this.turnControllers.delete(sessionKey);
    }
  }

  /** #456 — stop one in-flight turn for this actor + surface. */
  async stopTurn(actorUserId: string, surface?: string): Promise<void> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    const controller = this.turnControllers.get(sessionKey);
    if (!controller) return; // no turn in flight — idempotent no-op
    controller.abort();
    const session = this.sessions.get(sessionKey);
    if (session) {
      try {
        await session.engine.interrupt();
      } catch {
        // best-effort: the stop signal already broke the loop; interrupt failure must not wedge.
      }
    }
  }

  /** /clear drops the live engine; the next turn relaunches from the new thread. */
  async clear(
    actorUserId: string,
    options?: { incognito?: boolean },
    surface?: string
  ): Promise<void> {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    const currentThread = await this.deps.persistence.getCurrentThreadState?.(
      actorUserId,
      chatSurface
    );
    if (currentThread?.incognito) {
      await this.endPrivateSession(actorUserId, chatSurface);
      await this.deps.persistence.openNewConversation(actorUserId, options, chatSurface);
      return;
    }

    const session = this.sessions.get(sessionKey);
    if (session) {
      await session.engine.kill();
      this.sessions.delete(sessionKey);
      this.deps.revokeMcpToken?.(sessionKey);
    }
    await this.deps.persistence.openNewConversation(actorUserId, options, chatSurface);
  }

  async endPrivateSession(actorUserId: string, surface?: string): Promise<void> {
    const chatSurface = normalizeChatSurface(surface);
    const currentThread = await this.deps.persistence.getCurrentThreadState?.(
      actorUserId,
      chatSurface
    );
    if (!currentThread?.incognito) return;

    await cleanupPrivateSession(
      actorUserId,
      chatSurface,
      currentThread.id,
      this.sessions.get(surfaceSessionKey(actorUserId, chatSurface)),
      this.deps,
      this.sessions,
      (k) => clearPrivateDetachTimer(this.privateDetachTimers, k)
    );
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
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    // Validate ownership FIRST — a stale or foreign id must NOT disrupt the active session.
    // Only after confirming the thread exists and belongs to this user do we stop/drop.
    const found = await this.deps.persistence.touchExistingThread(
      actorUserId,
      threadId,
      chatSurface
    );
    if (!found) {
      throw new ChatThreadNotFoundError();
    }

    // Thread confirmed valid. Stop any in-flight turn (idempotent no-op when none is in flight).
    await this.stopTurn(actorUserId, chatSurface);

    // Drop the live engine so the next submitTurn launches fresh from the resumed thread.
    const session = this.sessions.get(sessionKey);
    if (session) {
      try {
        await session.engine.kill();
      } catch {
        // best-effort: session is dropped below regardless
      }
      this.sessions.delete(sessionKey);
      this.deps.revokeMcpToken?.(sessionKey);
    }
    this.pendingForcedReplay.add(sessionKey);
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
