/**
 * Small, self-contained helpers factored out of `chat-session-manager.ts` to keep that file
 * under the repo's file-size gate (`scripts/check-file-size.ts`, 1000-line cap). No behavior
 * change from the code they replace — pure extraction.
 */

import {
  normalizeChatSurface,
  parseSurfaceSessionKey,
  surfaceSessionKey,
  type ChatSurface
} from "./chat-surface.js";
import type { ChatPersistencePort, ChatSessionManagerDeps } from "./chat-session-ports.js";
import type { GateLifecycleHost } from "./classifier-gate-lifecycle.js";
import type { UserSession } from "./chat-session-provider-identity.js";
import { CliChatUnavailableError } from "./errors.js";
import { formatApprovalRecord, formatRefusalRecord } from "./acp-chat-engine.js";
import type { ActionResultMetadata, CliChatEngine, TranscriptRecord } from "./types.js";

export interface PendingActionResult {
  readonly record: TranscriptRecord;
  readonly recordSequence: number;
  readonly approvalSequence?: number;
}

/** Resolves after `ms` milliseconds. Used for polling backoff during turn/drain loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clearPrivateDetachTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  sessionKey: string
): void {
  const timer = timers.get(sessionKey);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(sessionKey);
}

export function schedulePrivateDetachTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  sessionKey: string,
  onTimeout: () => Promise<void>,
  delayMs = 30_000
): void {
  const timer = setTimeout(() => {
    timers.delete(sessionKey);
    void onTimeout().catch(() => {});
  }, delayMs);
  timer.unref?.();
  timers.set(sessionKey, timer);
}

/** Counts live subscribers across every surface for one actor. A key that fails to parse (a
 *  malformed external reconciliation key) can't belong to this actor. */
export function countSubscribersFor(
  subscribers: ReadonlyMap<string, ReadonlySet<unknown>>,
  actorUserId: string
): number {
  let count = 0;
  for (const [sessionKey, subs] of subscribers) {
    try {
      if (parseSurfaceSessionKey(sessionKey).actorUserId === actorUserId) {
        count += subs.size;
      }
    } catch {
      // A malformed external reconciliation key cannot belong to this actor.
    }
  }
  return count;
}

/**
 * #1554 Decision 2 — api-side half of a `sessionReaped` push: the pool already killed the
 * child, so this only drops the cache entry and revokes the MCP token. No-op if `sessionKey`
 * isn't in `sessions` (late/duplicate push) — called from within the caller's maintenance lock.
 */
export function applyRemoteReap(
  sessions: Map<string, unknown>,
  revokeMcpToken: ((sessionKey: string) => void) | undefined,
  sessionKey: string
): void {
  if (!sessions.has(sessionKey)) return;
  sessions.delete(sessionKey);
  revokeMcpToken?.(sessionKey);
}

export async function drainEngine(
  engine: { readNew: (offset: number) => Promise<{ offset: number; complete: boolean }> },
  fromOffset: number,
  pollMs: number
): Promise<number> {
  let offset = fromOffset;
  for (;;) {
    const { offset: next, complete } = await engine.readNew(offset);
    offset = next;
    if (complete) break;
    if (pollMs > 0) await delay(pollMs);
  }
  return offset;
}

export const TOOLS_LIST_OBSERVATION_TIMEOUT_MS = 10_000;
export const TOOLS_LIST_OBSERVATION_POLL_MS = 100;

export async function waitForNewToolsListObservation(
  getCount: ((token: string) => number) | undefined,
  now: () => number,
  token: string,
  baselineCount: number | undefined
): Promise<boolean | undefined> {
  if (!getCount || baselineCount === undefined) return undefined;
  const deadline = now() + TOOLS_LIST_OBSERVATION_TIMEOUT_MS;
  for (;;) {
    if (getCount(token) > baselineCount) return true;
    if (now() >= deadline) return false;
    await delay(TOOLS_LIST_OBSERVATION_POLL_MS);
  }
}

/**
 * #2164 r21 — the per-turn readiness check, extracted from `runTurn` (file-size gate). A per-turn
 * engine that answered without a fresh, identified tools/list attach is a broken turn: it emits the
 * fixed "tools were not available" status and throws `CliChatUnavailableError`. Returns normally for
 * every engine that does not need the guard (in-process, non-anthropic, no token, a tool already
 * used, or an empty reply).
 */
export async function assertNewToolsAttached(input: {
  readonly startsToolClientPerTurn: boolean | undefined;
  readonly provider: string;
  readonly mcpToken: string | undefined;
  readonly mcpToolInvoked: boolean;
  readonly reply: string;
  readonly toolsListBaseline: number | undefined;
  readonly getToolsListObservationCount: ((token: string) => number) | undefined;
  readonly now: () => number;
  readonly engine: unknown;
  readonly emitUnavailable: () => void;
}): Promise<void> {
  if (
    !input.startsToolClientPerTurn ||
    input.provider !== "anthropic" ||
    !input.mcpToken ||
    input.mcpToolInvoked ||
    !input.reply
  ) {
    return;
  }
  const toolsListReady = await waitForNewToolsListObservation(
    input.getToolsListObservationCount,
    input.now,
    input.mcpToken,
    input.toolsListBaseline
  );
  if (toolsListReady !== false) return;

  // #2164 r21 — bounded, scrubbed diagnostic; duck-typed cast since not on CliChatEngine.
  type Diagnostics = { readonly stderrTail: string; readonly exitCode: number | null };
  type DiagnosticsCapable = { getLastSubmitDiagnostics?: () => Diagnostics | undefined };
  const diag = (input.engine as DiagnosticsCapable).getLastSubmitDiagnostics?.();
  if (diag) {
    console.error(`[chat] readiness gate failed: exit=${diag.exitCode} stderr=${diag.stderrTail}`);
  }
  input.emitUnavailable();
  throw new CliChatUnavailableError("MCP tools were never attached before the reply was accepted");
}

export interface PrivateSessionRecord {
  readonly engine: CliChatEngine;
}

/** Replace one live record in persisted activity while retaining creation order. */
export function upsertActivityRecord(records: TranscriptRecord[], record: TranscriptRecord): void {
  if (record.id) {
    const existing = records.findIndex((item) => item.id === record.id);
    if (existing >= 0) {
      records[existing] = record;
      return;
    }
  }
  const insertion = records.findIndex(
    (item) =>
      record.sequence !== undefined &&
      item.sequence !== undefined &&
      item.sequence > record.sequence
  );
  if (insertion >= 0) records.splice(insertion, 0, record);
  else records.push(record);
}

/** Inject one gateway result, preserving its live payload and deriving any approval line after it. */
export function injectActionResultRecord(
  record: TranscriptRecord,
  options: {
    readonly sessionKey: string;
    readonly sequenceBySession: Map<string, number>;
    readonly recordSequence?: number;
    readonly approvalSequence?: number;
    readonly turnRecords?: TranscriptRecord[];
    readonly actionResults?: ActionResultMetadata[];
    readonly emit: (record: TranscriptRecord) => void;
  }
): void {
  if (record.kind !== "action_result" || !record.outcome) return;
  if (options.actionResults && options.actionResults.length < 20) {
    options.actionResults.push({
      kind: "action_result",
      text: (record.text ?? "").slice(0, 200),
      ...(record.toolName ? { toolName: record.toolName.slice(0, 120) } : {}),
      outcome: record.outcome
    });
  }

  // Pass through the gateway record unchanged before deriving the display line.
  options.emit(record);
  const nextSequence = () => {
    const next = (options.sequenceBySession.get(options.sessionKey) ?? 0) + 1;
    options.sequenceBySession.set(options.sessionKey, next);
    return next;
  };
  const ordered =
    record.sequence === undefined
      ? { ...record, sequence: options.recordSequence ?? nextSequence() }
      : record;
  const currentSequence = options.sequenceBySession.get(options.sessionKey) ?? 0;
  if (ordered.sequence !== undefined && ordered.sequence > currentSequence) {
    options.sequenceBySession.set(options.sessionKey, ordered.sequence);
  }
  if (options.turnRecords) upsertActivityRecord(options.turnRecords, ordered);

  const toolName = record.toolName ?? "tool";
  const decidedBy = record.decidedBy ?? "person";
  const durationSec =
    record.durationMs != null ? Math.max(1, Math.round(record.durationMs / 1000)) : undefined;
  const approvalSequence = options.approvalSequence ?? nextSequence();
  const mappedRecord =
    decidedBy === "policy"
      ? record.outcome === "denied"
        ? formatRefusalRecord({ toolName, reason: record.reason, sequence: approvalSequence })
        : null
      : formatApprovalRecord({
          toolName,
          approved: decidedBy === "person" && record.outcome !== "denied",
          who: decidedBy === "person" ? "you" : undefined,
          reason: record.reason,
          durationSec,
          durationMs: record.durationMs,
          sequence: approvalSequence
        });
  if (mappedRecord) {
    if (options.turnRecords) upsertActivityRecord(options.turnRecords, mappedRecord);
    options.emit(mappedRecord);
  }
}

export function flushPendingActionResults(
  pendingBySession: Map<string, PendingActionResult[]>,
  actorUserId: string,
  surface: ChatSurface,
  sessionKey: string,
  sequenceBySession: Map<string, number>,
  turnRecords: TranscriptRecord[] | undefined,
  actionResults: ActionResultMetadata[] | undefined,
  emit: (actorUserId: string, surface: ChatSurface, record: TranscriptRecord) => void,
  beforeSequence?: number
): void {
  const pending = pendingBySession.get(sessionKey);
  if (!pending) return;
  const ready =
    beforeSequence === undefined
      ? pending
      : pending.filter((item) => item.recordSequence < beforeSequence);
  if (ready.length === 0) return;
  if (ready.length === pending.length) pendingBySession.delete(sessionKey);
  else {
    pendingBySession.set(
      sessionKey,
      pending.filter((item) => item.recordSequence >= beforeSequence!)
    );
  }
  for (const item of ready) {
    injectActionResultRecord(item.record, {
      sessionKey,
      sequenceBySession,
      recordSequence: item.recordSequence,
      approvalSequence: item.approvalSequence,
      turnRecords,
      actionResults,
      emit: (next) => emit(actorUserId, surface, next)
    });
  }
}

export function createPendingActionResultFlusher(
  pendingBySession: Map<string, PendingActionResult[]>,
  actorUserId: string,
  surface: ChatSurface,
  sessionKey: string,
  sequenceBySession: Map<string, number>,
  turnRecords: TranscriptRecord[] | undefined,
  actionResults: ActionResultMetadata[] | undefined,
  emit: (actorUserId: string, surface: ChatSurface, record: TranscriptRecord) => void
): (lastDeliveredSequence: number, beforeSequence?: number) => number {
  return (lastDeliveredSequence, beforeSequence) => {
    const pending = pendingBySession.get(sessionKey) ?? [];
    const ready =
      beforeSequence === undefined
        ? pending
        : pending.filter((item) => item.recordSequence < beforeSequence);
    if (ready.length === 0) return lastDeliveredSequence;
    flushPendingActionResults(
      pendingBySession,
      actorUserId,
      surface,
      sessionKey,
      sequenceBySession,
      turnRecords,
      actionResults,
      emit,
      beforeSequence
    );
    return ready.reduce(
      (max, item) => Math.max(max, item.approvalSequence ?? item.recordSequence),
      lastDeliveredSequence
    );
  };
}

export async function cleanupPrivateSession(
  actorUserId: string,
  surface: ChatSurface,
  threadId: string | undefined,
  session: PrivateSessionRecord | undefined,
  deps: ChatSessionManagerDeps,
  sessions: Map<string, PrivateSessionRecord>,
  clearDetachTimer: (key: string) => void
): Promise<void> {
  const sessionKey = surfaceSessionKey(actorUserId, surface);
  let purged = false;
  if (session) {
    try {
      if (session.engine.purgeTranscripts) await session.engine.purgeTranscripts();
    } catch {
      /* best-effort */
    }
    try {
      await session.engine.kill({ preserveNeutralDir: true });
    } catch {
      /* best-effort */
    }
    sessions.delete(sessionKey);
    clearDetachTimer(sessionKey);
    deps.revokeMcpToken?.(sessionKey);
  } else {
    try {
      if (deps.purgePrivateTranscripts) {
        await deps.purgePrivateTranscripts(sessionKey);
        purged = true;
      }
    } catch {
      /* best-effort */
    }
  }
  if (purged && threadId) {
    await deps.persistence.deleteThread?.(actorUserId, threadId, surface);
  }
}

/** #456 — stop one in-flight turn for this actor + surface. Idempotent no-op when none runs. */
export async function stopSessionTurn(input: {
  readonly actorUserId: string;
  readonly surface: ChatSurface;
  readonly turnControllers: Map<string, AbortController>;
  readonly sessions: Map<string, UserSession>;
}): Promise<void> {
  const sessionKey = surfaceSessionKey(input.actorUserId, input.surface);
  const controller = input.turnControllers.get(sessionKey);
  if (!controller) return; // no turn in flight — idempotent no-op
  controller.abort();
  const session = input.sessions.get(sessionKey);
  if (session) {
    try {
      await session.engine.interrupt();
    } catch {
      // best-effort: the stop signal already broke the loop; interrupt failure must not wedge.
    }
  }
}

/** /clear drops the live engine; the next turn relaunches from the new thread. */
export async function clearChatSession(input: {
  readonly actorUserId: string;
  readonly surface?: string;
  readonly options?: { incognito?: boolean };
  readonly persistence: Pick<ChatPersistencePort, "getCurrentThreadState" | "openNewConversation">;
  readonly sessions: Map<string, UserSession>;
  readonly stopTurn: (actorUserId: string, surface: ChatSurface) => Promise<void>;
  readonly endPrivateSession: (actorUserId: string, surface: ChatSurface) => Promise<void>;
  readonly revokeMcpToken?: (sessionKey: string) => void;
}): Promise<void> {
  const chatSurface = normalizeChatSurface(input.surface);
  const sessionKey = surfaceSessionKey(input.actorUserId, chatSurface);
  // #2934 — stop a running turn the way resume does, before the thread flips: the
  // in-flight turn must resolve stopped instead of saving under the new chat.
  await input.stopTurn(input.actorUserId, chatSurface);
  const currentThread = await input.persistence.getCurrentThreadState?.(
    input.actorUserId,
    chatSurface
  );
  if (currentThread?.incognito) {
    await input.endPrivateSession(input.actorUserId, chatSurface);
    await input.persistence.openNewConversation(input.actorUserId, input.options, chatSurface);
    return;
  }

  const session = input.sessions.get(sessionKey);
  if (session) {
    await session.engine.kill();
    input.sessions.delete(sessionKey);
    input.revokeMcpToken?.(sessionKey);
  }
  await input.persistence.openNewConversation(input.actorUserId, input.options, chatSurface);
}

export async function sweepOrphanedPrivateThreads(
  effectiveLive: ReadonlySet<string>,
  deps: ChatSessionManagerDeps,
  sessions: Map<string, PrivateSessionRecord>,
  clearDetachTimer: (key: string) => void
): Promise<void> {
  const rows = (await deps.persistence.listIncognitoThreadStates?.()) ?? [];
  for (const row of rows) {
    const surface = normalizeChatSurface(row.surface);
    const sessionKey = surfaceSessionKey(row.actorUserId, surface);
    if (effectiveLive.has(sessionKey) || sessions.has(sessionKey)) continue;
    await cleanupPrivateSession(
      row.actorUserId,
      surface,
      row.threadId,
      undefined,
      deps,
      sessions,
      clearDetachTimer
    );
  }
}

/** The host slice {@link healAndRelaunchSession} needs: the shared turn-lifecycle host plus the
 *  manager's serialized launcher. */
export interface SessionRecoveryHost extends GateLifecycleHost {
  ensureSession(
    actorUserId: string,
    userName: string,
    opts?: { readonly forceReplay?: boolean },
    surface?: string
  ): Promise<UserSession>;
}

/**
 * #1157 self-heal: the engine behind this session is gone (the daemon killed it after a
 * VerifiedSubmitError, the cli-runner restarted, or the tmux server died with the container). Evict
 * the stale entry, revoke the per-session MCP token (a fresh one is minted on relaunch), force a
 * conversation replay so the fresh engine has context, and relaunch. The caller retries the submit
 * exactly once — a second failure surfaces.
 */
export async function healAndRelaunchSession(
  host: SessionRecoveryHost,
  actorUserId: string,
  userName: string,
  dead: UserSession
): Promise<UserSession> {
  const sessionKey = surfaceSessionKey(actorUserId, dead.surface);
  if (host.sessions.get(sessionKey) === dead) host.sessions.delete(sessionKey);
  host.deps.revokeMcpToken?.(sessionKey);
  try {
    await dead.engine.kill();
  } catch {
    // Already dead — kill is best-effort teardown of a stale handle.
  }
  host.pendingForcedReplay.add(sessionKey);
  host.emit(actorUserId, dead.surface, {
    kind: "status",
    text: "Chat session was lost — reconnecting…"
  });
  return host.ensureSession(actorUserId, userName, undefined, dead.surface);
}
