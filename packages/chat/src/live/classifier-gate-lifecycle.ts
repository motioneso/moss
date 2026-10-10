import { randomUUID } from "node:crypto";

import type { ChatClassifierGateOriginV1, SourceFreshnessV1 } from "@moss/shared";

import type { StoredAttachmentMeta } from "../attachments-service.js";
import type { ChatSurface } from "./chat-surface.js";
import { surfaceSessionKey } from "./chat-surface.js";
import type {
  ChatPersistencePort,
  ChatSessionManagerDeps,
  HandledTurnOptions
} from "./chat-session-ports.js";
import type { GateMode, GateOutcome, GateRequest } from "./classifier-gate.js";
import type { UserSession } from "./chat-session-provider-identity.js";
import type { TranscriptRecord } from "./types.js";
import { getSelectedThreadState, usesMainThreadSelection } from "./chat-thread-selection.js";

/**
 * Task 4.1 (#2901) — the handled-turn lifecycle, extracted from ChatSessionManager so that file
 * stays under the repo's line cap. Everything here is pure orchestration over the host's already
 * public seams: the injected gate runner, the persistence port, the live-session map, and the SSE
 * emitter. It launches no engine and records no model execution.
 */

/** The shape a completed live turn returns to its caller. */
export interface GateTurnResult {
  reply: string;
  userMessageId?: string;
  assistantMessageId?: string;
  sourceFreshness?: SourceFreshnessV1 | null;
}

/** The slice of ChatSessionManager the gate lifecycle needs. */
export interface GateLifecycleHost {
  readonly deps: ChatSessionManagerDeps;
  readonly sessions: Map<string, UserSession>;
  readonly pendingForcedReplay: Set<string>;
  emit(actorUserId: string, surface: ChatSurface, record: TranscriptRecord): void;
}

/**
 * Task 4.1 (#2901) — the live reply when a mutating gate action ran but its turn could not be
 * saved. Never replay: the default model would repeat an action that already happened.
 */
export const GATE_STORAGE_FAILURE_MESSAGE =
  "That action ran, but its result could not be saved. Check before trying again.";

/**
 * One gate attempt before any engine launch. Returns the completed turn (if the gate handled it,
 * hit a terminal failure, or the user stopped it) plus the turn's privacy, captured below. A
 * decline (so the default model path runs), `off`/`shadow`/incognito, and read-storage-failure
 * all return an undefined result.
 */
export async function tryGatedTurn(
  host: GateLifecycleHost,
  actorUserId: string,
  surface: ChatSurface,
  text: string,
  opts:
    | {
        readonly attachments?: readonly StoredAttachmentMeta[];
        readonly moduleControl?: string;
        /** #2956: the turn the gate's check lines join. */
        readonly turnId?: string;
        readonly parentId?: string;
      }
    | undefined,
  controller: AbortController,
  flushActions?: () => Promise<Pick<HandledTurnOptions, "activityRecords" | "actionResults">>
): Promise<{
  result: GateTurnResult | undefined;
  requestIncognito: boolean;
  requestThreadId: string | null;
}> {
  // Capture identity and privacy together BEFORE the gate-mode wait. A warm engine stays bound,
  // an explicit resume/new chat follows current state, and only a cold drawer reconnect selects Main.
  const sessionKey = surfaceSessionKey(actorUserId, surface);
  const existingSession = host.sessions.get(sessionKey);
  const threadState = existingSession
    ? { id: existingSession.threadId, incognito: existingSession.incognito }
    : await getSelectedThreadState({
        actorUserId,
        surface,
        useMain: usesMainThreadSelection({
          surface,
          forceReplay: host.pendingForcedReplay.has(sessionKey)
        }),
        persistence: host.deps.persistence
      });
  const requestIncognito = threadState?.incognito ?? false;
  const requestThreadId = threadState?.id ?? null;
  const gate = host.deps.classifierGate;
  if (!gate) return { result: undefined, requestIncognito, requestThreadId };

  let mode: GateMode;
  try {
    mode = await gate.mode(actorUserId);
  } catch {
    // A settings read failure behaves as `off`: chat must never break because the gate did.
    return { result: undefined, requestIncognito, requestThreadId };
  }
  if (mode !== "on") return { result: undefined, requestIncognito, requestThreadId };

  // Ruling 9: private chats bypass the gate entirely — no classifier call and no record.
  if (requestIncognito) return { result: undefined, requestIncognito, requestThreadId };

  const request: GateRequest = {
    actorUserId,
    threadId: requestThreadId,
    message: text,
    hasAttachment: (opts?.attachments?.length ?? 0) > 0,
    incognito: requestIncognito,
    mode,
    signal: controller.signal,
    // #2956: the turn the gate's check lines join (and the answer line id).
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    ...(opts?.parentId ? { parentId: opts.parentId } : {})
  };
  let outcome: GateOutcome;
  try {
    outcome = await gate.evaluate(request);
  } catch {
    // Gate infrastructure failure is a decline: the default model still answers once — unless the
    // user already stopped the turn, in which case no fallback may run (checked below).
    if (controller.signal.aborted)
      return {
        result: cancelledTurn(host, actorUserId, surface),
        requestIncognito,
        requestThreadId
      };
    return { result: undefined, requestIncognito, requestThreadId };
  }

  // A Stop that landed while the gate was deciding must stop the turn, not fall through to the
  // default model. The gate may still report `declined` (for example a read it dispatched failed
  // after the abort), so the signal is the authority here, checked before any decline branch.
  if (controller.signal.aborted)
    return { result: cancelledTurn(host, actorUserId, surface), requestIncognito, requestThreadId };

  if (outcome.kind === "declined" || outcome.kind === "would_handle")
    return { result: undefined, requestIncognito, requestThreadId };
  if (outcome.kind === "cancelled")
    return { result: cancelledTurn(host, actorUserId, surface), requestIncognito, requestThreadId };
  const actionOptions = await flushActions?.();
  if (controller.signal.aborted)
    return { result: cancelledTurn(host, actorUserId, surface), requestIncognito, requestThreadId };
  return {
    result: await persistGateOutcome(
      host,
      actorUserId,
      surface,
      requestThreadId,
      text,
      opts,
      outcome,
      actionOptions
    ),
    requestIncognito,
    requestThreadId
  };
}

/** Emits the same status the default path uses on Stop and persists nothing. */
function cancelledTurn(
  host: GateLifecycleHost,
  actorUserId: string,
  surface: ChatSurface
): GateTurnResult {
  host.emit(actorUserId, surface, { kind: "status", text: "Stopped by user." });
  return { reply: "" };
}

/**
 * Persists and emits exactly one ordinary chat turn for a gate outcome that ran (handled or
 * terminal failure). No engine is launched, no classifier prose reaches the user, and no fabricated
 * provider/model/usage is recorded — the assistant message carries the gate origin.
 */
async function persistGateOutcome(
  host: GateLifecycleHost,
  actorUserId: string,
  surface: ChatSurface,
  threadId: string | null,
  text: string,
  opts: { readonly attachments?: readonly StoredAttachmentMeta[] } | undefined,
  outcome: Extract<GateOutcome, { kind: "handled" | "terminal_failure" }>,
  actionOptions?: Pick<HandledTurnOptions, "activityRecords" | "actionResults">
): Promise<GateTurnResult | undefined> {
  const handled = outcome.kind === "handled";
  const reply = handled ? outcome.reply : outcome.message;
  const trace = outcome.trace;
  const attachments = opts?.attachments ?? [];
  const origin: ChatClassifierGateOriginV1 = {
    version: 1,
    kind: "classifier_gate",
    decisionId: randomUUID(),
    moduleId: trace.moduleId ?? null,
    toolName: trace.toolName ?? null,
    outcome: handled ? "executed-success" : "executed-failure-or-unknown"
  };
  const handledOpts: HandledTurnOptions = {
    threadId,
    ...actionOptions,
    attachments:
      attachments.length > 0
        ? attachments.map((meta) => ({
            id: meta.id,
            fileName: meta.fileName,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes
          }))
        : undefined
  };

  // Emit the user's message only once this turn is committed to the gate path. On a read storage
  // failure that falls back, the default path below emits the user message itself — emitting it
  // here first would show it twice on the live stream (QA should-fix 6).
  let stored:
    | Awaited<ReturnType<NonNullable<ChatPersistencePort["recordHandledTurn"]>>>
    | undefined;
  let storageFailed = false;
  if (!host.deps.persistence.recordHandledTurn) {
    storageFailed = true;
  } else {
    try {
      stored = await host.deps.persistence.recordHandledTurn(
        actorUserId,
        text,
        reply,
        origin,
        handledOpts,
        surface
      );
    } catch {
      storageFailed = true;
    }
  }

  if (storageFailed || stored === undefined) {
    // D4: only a read may be repeated by the default model. A handled non-read already ran, and a
    // terminal failure is by definition a non-read attempt. Unknown risk counts as mutating: an
    // unrecognized trace must fail safe (never replay) rather than assume the safe case.
    const mutating = !handled || trace.risk !== "read";
    // A read falls back: emit nothing here, so the default path is the single source of the user's
    // message and its reply.
    if (!mutating) return undefined;
    // The turn is committed to the gate path: emit the user message now, then the code-written reply.
    host.emit(actorUserId, surface, { kind: "user", text });
    const fallback = handled ? GATE_STORAGE_FAILURE_MESSAGE : reply;
    host.emit(actorUserId, surface, { kind: "reply", text: fallback, origin });
    return { reply: fallback };
  }

  // Post-store: the user message and the reply, with the reply carrying its id (and freshness) so
  // the live UI reconciles with history, mirroring the default-model path.
  host.emit(actorUserId, surface, { kind: "user", text });
  host.emit(actorUserId, surface, {
    kind: "reply",
    text: reply,
    messageId: stored.assistantMessageId,
    ...(stored.sourceFreshness !== undefined ? { sourceFreshness: stored.sourceFreshness } : {}),
    origin
  });

  // D5: a warm model session never received this turn. Drop it and force a normal-history replay on
  // the next default turn, without submitting a synthetic turn during this reply.
  await dropWarmSessionForGate(host, actorUserId, surface);

  return {
    reply,
    userMessageId: stored.userMessageId,
    assistantMessageId: stored.assistantMessageId,
    sourceFreshness: stored.sourceFreshness
  };
}

/**
 * Drops any live session for this actor + surface after a gate-handled turn and marks the key for a
 * forced replay, so the next default turn relaunches with the handled turn in normal history.
 */
async function dropWarmSessionForGate(
  host: GateLifecycleHost,
  actorUserId: string,
  surface: ChatSurface
): Promise<void> {
  const sessionKey = surfaceSessionKey(actorUserId, surface);
  const session = host.sessions.get(sessionKey);
  if (session) {
    if (host.sessions.get(sessionKey) === session) host.sessions.delete(sessionKey);
    host.deps.revokeMcpToken?.(sessionKey);
    try {
      await session.engine.kill();
    } catch {
      // Best-effort teardown of a session the next default turn will relaunch anyway.
    }
  }
  host.pendingForcedReplay.add(sessionKey);
}
