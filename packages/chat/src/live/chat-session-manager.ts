import type { ProviderKind } from "@moss/ai";
import { resolveMossEnv } from "@moss/db";
import type { AnswerProvenanceMetadataV1, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import { finalizeProvenance, parseAnswerMarkers } from "./answer-provenance.js";
import { renderAttachmentsManifest } from "./attachments-manifest.js";
import { renderReplayBlock, renderSummaryBlock } from "./chat-context-blocks.js";
import { isBoundedFallbackEngine } from "./engine-selection.js";
import { buildEngineText } from "./engine-text.js";
import {
  ChatStreamLimitError,
  ChatThreadNotFoundError,
  ChatTurnInFlightError,
  CliChatDeliveryUnknownError,
  CliChatUnavailableError
} from "./errors.js";
import { renderPersona } from "./persona.js";
import { renderMemorySeedBlock } from "./recall-seed.js";
import type {
  ActionResultMetadata,
  CliChatEngine,
  EngineKillOpts,
  TranscriptRecord
} from "./types.js";
import type { ReapReason } from "./provider-runtime.js";
import { applyRemoteReap, countSubscribersFor, delay } from "./session-runtime-helpers.js";
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
export type {
  ChatPersistencePort,
  ChatSessionManagerDeps,
  Clock,
  PassiveRetrievalPort,
  PrivateThreadState
} from "./chat-session-ports.js";
import type { ChatSessionManagerDeps } from "./chat-session-ports.js";

type Subscriber = (record: TranscriptRecord) => void;

interface UserSession {
  actorUserId: string;
  surface: ChatSurface;
  engine: CliChatEngine;
  provider: ProviderKind;
  model: string;
  lastActivity: number;
  transcriptOffset: number;
  incognito: boolean;
  readonly seededContextKeys: Set<string>;
  /**
   * #2164 — the token this session's engine was launched with, kept so a bounded-fallback
   * turn can check MCP tools-list readiness after the fact (see `mcpToken` usage in `runTurn`).
   * Undefined when no MCP client was configured for this session at all.
   */
  readonly mcpToken?: string;
  /**
   * #2164 — true when this session's engine is a bounded-fallback (one-shot, print) engine.
   * Those engines start their MCP client per turn inside `submit()`, so the #2159 launch-time
   * readiness gate is skipped for them (nothing to observe yet at launch) and a tool-less reply
   * can otherwise be accepted before we know the CLI ever attached the MCP tools at all.
   */
  readonly isBoundedFallbackEngine: boolean;
}

const MAX_SUBSCRIBERS_PER_ACTOR = 5;
const MAX_SUBSCRIBERS_TOTAL_PER_ACTOR = MAX_SUBSCRIBERS_PER_ACTOR * 2;
const PRIVATE_DETACH_GRACE_MS = 30_000;
const TOOLS_LIST_OBSERVATION_TIMEOUT_MS = 10_000;
const TOOLS_LIST_OBSERVATION_POLL_MS = 25;

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
  private readonly pollMs: number;
  /** #456 — idle/heartbeat watchdog window; 0 disables (tests only). */
  private readonly idleWatchdogMs: number;
  /** #342: RPC engines own replay submit/drain; in-process engines do it here. */
  private readonly serverOwnsDrain: boolean;
  /** #342: serializes reconciliation and idle reaping, which both mutate sessions/tokens. */
  private maintenanceMutex: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ChatSessionManagerDeps) {
    this.pollMs = deps.pollMs ?? 25;
    this.idleWatchdogMs = deps.idleWatchdogMs ?? 180_000;
    this.serverOwnsDrain = deps.serverOwnsDrain ?? false;
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
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const inFlight = this.launching.get(sessionKey);
    if (inFlight) return inFlight;

    const forceReplay = opts?.forceReplay ?? this.pendingForcedReplay.delete(sessionKey);
    const launch = this.launchSession(actorUserId, userName, { forceReplay }, chatSurface);
    this.launching.set(sessionKey, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(sessionKey);
    }
  }

  private async launchSession(
    actorUserId: string,
    userName: string,
    opts: { readonly forceReplay?: boolean } | undefined,
    surface: ChatSurface
  ): Promise<UserSession> {
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    const { provider, model, executionMode } =
      await this.deps.persistence.resolveActiveProvider(actorUserId);
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

    const engine = await this.deps.engineFactory(provider, sessionKey, { executionMode });

    // Rebuild replay from live state for every launch; recall precedes conversation replay.
    const recallResult = this.deps.recall ? await this.deps.recall.recall(actorUserId) : null;
    const seedBudgetEnv = resolveMossEnv(process.env, "JARVIS_CHAT_SEED_BUDGET_TOKENS");
    const seedBudget = seedBudgetEnv ? parseInt(seedBudgetEnv, 10) : 1500;
    const memorySeed = recallResult
      ? renderMemorySeedBlock(recallResult.episodicChunks, recallResult.facts, seedBudget)
      : "";

    const [threadState, { recent: recentTurns, oldSummary }] = await Promise.all([
      this.deps.persistence.getCurrentThreadState?.(actorUserId, surface),
      this.deps.persistence.listPriorTurns(actorUserId, { forceReplay: opts?.forceReplay }, surface)
    ]);
    if (threadState?.incognito && surface !== DEFAULT_CHAT_SURFACE) {
      throw new CliChatUnavailableError("private chat is only available in the drawer");
    }
    if (threadState?.incognito && !engine.purgeTranscripts) {
      throw new CliChatUnavailableError("private session unavailable");
    }
    const mcpConfig = await this.deps.mintMcpToken?.(actorUserId, sessionKey);
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
      mcpToken: mcpConfig?.token,
      mcpServerUrl: mcpConfig?.mcpServerUrl
    });

    // #2159 — block session readiness (and so the first user message) until this session's MCP
    // client has completed its first tools/list, closing the race where the terminal composer
    // reads "ready" before the CLI's own tool-discovery round trip against our server has landed.
    // #2164 — bounded-fallback (print/one-shot) engines never start an MCP client inside launch()
    // (only per-turn, in submit()), so waiting here would always time out and tear down the
    // session before its first message. Only engines that start MCP during launch() get the wait.
    if (mcpConfig?.token && !isBoundedFallbackEngine(provider, executionMode)) {
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
      lastActivity: this.deps.clock.now(),
      transcriptOffset: offset,
      incognito: threadState?.incognito ?? false,
      seededContextKeys: new Set(),
      mcpToken: mcpConfig?.token,
      isBoundedFallbackEngine: isBoundedFallbackEngine(provider, executionMode)
    };
    this.sessions.set(sessionKey, session);

    // #342 — only in-process engines need manager-owned replay submit + drain.
    if (replayBatch !== undefined && !this.serverOwnsDrain) {
      await engine.submit(replayBatch);
      // Drain (and discard) so real turn records start from a clean offset.
      session.transcriptOffset = await this.drain(engine, session.transcriptOffset);
    }

    return session;
  }

  // #2164 r21 — true once a fresh attach lands (count exceeds baseline), false after
  // TOOLS_LIST_OBSERVATION_TIMEOUT_MS, undefined when there's nothing to compare (guard skipped).
  private async waitForNewToolsListObservation(
    token: string,
    baselineCount: number | undefined
  ): Promise<boolean | undefined> {
    const getCount = this.deps.getToolsListObservationCount;
    if (!getCount || baselineCount === undefined) return undefined;
    const deadline = this.deps.clock.now() + TOOLS_LIST_OBSERVATION_TIMEOUT_MS;
    for (;;) {
      if (getCount(token) > baselineCount) return true;
      if (this.deps.clock.now() >= deadline) return false;
      await delay(TOOLS_LIST_OBSERVATION_POLL_MS);
    }
  }

  /**
   * #1157 self-heal: the engine behind this session is gone (the daemon killed it after a
   * VerifiedSubmitError, the cli-runner restarted, or the tmux server died with the
   * container). Evict the stale entry, revoke the per-session MCP token (a fresh one is
   * minted on relaunch), force a conversation replay so the fresh engine has context, and
   * relaunch. The caller retries the submit exactly once — a second failure surfaces.
   */
  private async healAndRelaunch(
    actorUserId: string,
    userName: string,
    dead: UserSession
  ): Promise<UserSession> {
    const sessionKey = surfaceSessionKey(actorUserId, dead.surface);
    if (this.sessions.get(sessionKey) === dead) this.sessions.delete(sessionKey);
    this.deps.revokeMcpToken?.(sessionKey);
    try {
      await dead.engine.kill();
    } catch {
      // Already dead — kill is best-effort teardown of a stale handle.
    }
    this.pendingForcedReplay.add(sessionKey);
    this.emit(actorUserId, dead.surface, {
      kind: "status",
      text: "Chat session was lost — reconnecting…"
    });
    return this.ensureSession(actorUserId, userName, undefined, dead.surface);
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
    session.transcriptOffset = await this.drain(session.engine, session.transcriptOffset);
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
    // #1157: a failed launch (dead tmux server, stale daemon state) gets one retry before surfacing.
    let session: UserSession;
    try {
      session = await this.ensureSession(actorUserId, userName, undefined, surface);
    } catch (err) {
      if (!(err instanceof CliChatUnavailableError)) throw err;
      this.pendingForcedReplay.add(surfaceSessionKey(actorUserId, surface));
      session = await this.ensureSession(actorUserId, userName, undefined, surface);
    }

    // #456 — per-turn stop signal. stopTurn(actorUserId) aborts this; the poll loop checks
    // signal.aborted after every readNew and breaks cleanly (no error) when set.
    const controller = new AbortController();
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    this.turnControllers.set(sessionKey, controller);
    this.actionResultsBySession.set(sessionKey, []);

    try {
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
          session = await this.healAndRelaunch(actorUserId, userName, session);
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
        } catch {
          // #456 — a killed engine rejects its in-flight readNew. If the user stopped the turn,
          // break cleanly; otherwise rethrow (a genuine engine failure surfaces to the caller).
          if (controller.signal.aborted) {
            stopped = true;
            break;
          }
          throw new Error("readNew failed");
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
          const rejectionOnly = record.kind === "tool" && !record.toolName && !record.text?.trim();
          if (!rejectionOnly) this.emit(actorUserId, surface, record);
          if (record.kind === "reply") reply = record.text;
          if (record.kind === "tool" && record.toolName) {
            invokedToolNames.add(record.toolName);
            if (record.toolName.startsWith("mcp__"))
              mcpAttempts.push({ name: record.toolName, id: record.toolCallId });
          }
          if (record.kind === "tool" && record.rejected && record.toolCallId)
            rejectedCallIds.add(record.toolCallId);
        }
        if (complete) break;
        // #456 — user-driven Stop: the signal aborts mid-turn; break cleanly (no error) so the
        // turn-in-flight lock releases and the UI returns to input-ready. Persist nothing.
        if (controller.signal.aborted) {
          stopped = true;
          break;
        }
        // #456 — idle/heartbeat watchdog: break only when the engine emitted NOTHING for the full
        // window (an actively-producing turn keeps resetting the deadline). No reply → recordTurn skipped.
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

      // #2164 — a bounded-fallback engine starts its MCP client per turn in `submit()`, so the
      // #2159 gate is skipped for it; check only when no MCP tool fired. Only a non-rejected
      // `mcp__` attempt with a call id proves attachment (r22 fixed an id-less bypass).
      const mcpToolInvoked = mcpAttempts.some((a) => a.id != null && !rejectedCallIds.has(a.id));
      if (
        session.isBoundedFallbackEngine &&
        session.provider === "anthropic" &&
        session.mcpToken &&
        !mcpToolInvoked &&
        reply
      ) {
        const toolsListReady = await this.waitForNewToolsListObservation(
          session.mcpToken,
          toolsListBaseline
        );
        if (toolsListReady === false) {
          // #2164 r21 — bounded, scrubbed diagnostic; duck-typed cast since not on CliChatEngine.
          type Diagnostics = { readonly stderrTail: string; readonly exitCode: number | null };
          type DiagnosticsCapable = { getLastSubmitDiagnostics?: () => Diagnostics | undefined };
          const diag = (session.engine as DiagnosticsCapable).getLastSubmitDiagnostics?.();
          if (diag) {
            console.error(
              `[chat] readiness gate failed: exit=${diag.exitCode} stderr=${diag.stderrTail}`
            );
          }
          this.emit(actorUserId, surface, {
            kind: "status",
            text: "Chat tools were not available for this reply — please try again."
          });
          throw new CliChatUnavailableError(
            "MCP tools were never attached before the reply was accepted"
          );
        }
      }

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
          actionResults: this.actionResultsBySession.get(sessionKey)
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
          sourceFreshness: stored.sourceFreshness
        });
      }

      return {
        reply,
        userMessageId: stored?.userMessageId,
        assistantMessageId: stored?.assistantMessageId,
        sourceFreshness: stored?.sourceFreshness
      };
    } finally {
      this.actionResultsBySession.delete(sessionKey);
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

    await this.cleanupPrivateSession(
      actorUserId,
      chatSurface,
      currentThread.id,
      this.sessions.get(surfaceSessionKey(actorUserId, chatSurface))
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
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    const session = this.sessions.get(sessionKey);
    if (session) {
      await session.engine.kill();
      this.sessions.delete(sessionKey);
      this.deps.revokeMcpToken?.(sessionKey);
    }
    await this.ensureSession(actorUserId, userName, { forceReplay: true }, chatSurface);
  }

  /** #1081 — drop live sessions after a provider binary replacement. */
  async dropSessionsForProvider(provider: ProviderKind): Promise<void> {
    await this.withMaintenanceLock(async () => {
      for (const [actorUserId, session] of this.sessions) {
        if (session.provider !== provider) continue;
        try {
          await session.engine.kill();
        } catch {
          // best-effort: a hung/failed kill must not strand the session — drop it below regardless.
        }
        this.sessions.delete(actorUserId);
        this.deps.revokeMcpToken?.(actorUserId);
      }
    });
  }

  /** Register one surface subscriber and return its unsubscribe handle. */
  subscribe(actorUserId: string, fn: Subscriber, surface?: string): () => void {
    const chatSurface = normalizeChatSurface(surface);
    const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
    this.clearPrivateDetachTimer(sessionKey);
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
          this.schedulePrivateEnd(actorUserId, chatSurface);
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
      const results = this.actionResultsBySession.get(sessionKey);
      if (results && results.length < 20) {
        results.push({
          kind: "action_result",
          text: record.text.slice(0, 200),
          ...(record.toolName ? { toolName: record.toolName.slice(0, 120) } : {}),
          outcome: record.outcome
        });
      }
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
            await this.cleanupPrivateSession(
              session.actorUserId,
              session.surface,
              thread?.incognito ? thread.id : undefined,
              session
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
      await this.sweepOrphanedPrivateThreads(effectiveLive);
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

  /**
   * Run `fn` under the shared §5.4 maintenance mutex (a serialized promise chain), so the two
   * session-map-mutating maintenance paths — reconciliation and idle reaping — are mutually
   * exclusive. The chain advances regardless of whether `fn` resolves or rejects.
   */
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

  private schedulePrivateEnd(actorUserId: string, surface: ChatSurface): void {
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    const timer = setTimeout(() => {
      this.privateDetachTimers.delete(sessionKey);
      void this.endPrivateSession(actorUserId, surface).catch(() => {});
    }, PRIVATE_DETACH_GRACE_MS);
    timer.unref?.();
    this.privateDetachTimers.set(sessionKey, timer);
  }

  private clearPrivateDetachTimer(actorUserId: string): void {
    const timer = this.privateDetachTimers.get(actorUserId);
    if (!timer) return;
    clearTimeout(timer);
    this.privateDetachTimers.delete(actorUserId);
  }

  private async cleanupPrivateSession(
    actorUserId: string,
    surface: ChatSurface,
    threadId: string | undefined,
    session: UserSession | undefined
  ): Promise<void> {
    const sessionKey = surfaceSessionKey(actorUserId, surface);
    // #744/#1086 — the incognito row is the boot sweep's ONLY reclaim handle. A live CLI can
    // recreate its transcript after rm, so only the engine-less post-exit sweep may clear it.
    let purged = false;
    if (session) {
      try {
        if (session.engine.purgeTranscripts) {
          await session.engine.purgeTranscripts();
        }
      } catch {
        /* best-effort live purge; the row is retained regardless for the post-exit sweep */
      }
      try {
        const killArgs: [EngineKillOpts?] = [{ preserveNeutralDir: true }];
        await (this.deps.killSession
          ? this.deps.killSession(sessionKey, ...killArgs)
          : session.engine.kill(...killArgs));
      } catch {
        /* best-effort private kill */
      }
      // Process teardown is unconditional. The marker and row survive until a later sweep can
      // prove the process is gone and purge without a recreate race (#1086).
      this.sessions.delete(sessionKey);
      this.clearPrivateDetachTimer(sessionKey);
      this.deps.revokeMcpToken?.(sessionKey);
    } else {
      try {
        if (this.deps.purgePrivateTranscripts) {
          await this.deps.purgePrivateTranscripts(sessionKey);
          purged = true;
        }
      } catch {
        /* best-effort restart purge; keep the row for the next reconcile/boot sweep */
      }
    }
    if (purged && threadId) {
      await this.deps.persistence.deleteThread?.(actorUserId, threadId, surface);
    }
  }

  private async sweepOrphanedPrivateThreads(effectiveLive: ReadonlySet<string>): Promise<void> {
    const rows = (await this.deps.persistence.listIncognitoThreadStates?.()) ?? [];
    for (const row of rows) {
      const surface = normalizeChatSurface(row.surface);
      const sessionKey = surfaceSessionKey(row.actorUserId, surface);
      if (effectiveLive.has(sessionKey) || this.sessions.has(sessionKey)) continue;
      await this.cleanupPrivateSession(row.actorUserId, surface, row.threadId, undefined);
    }
  }

  private async drain(engine: CliChatEngine, fromOffset: number): Promise<number> {
    let offset = fromOffset;
    for (;;) {
      const { offset: next, complete } = await engine.readNew(offset);
      offset = next;
      if (complete) break;
      if (this.pollMs > 0) await delay(this.pollMs);
    }
    return offset;
  }
}
