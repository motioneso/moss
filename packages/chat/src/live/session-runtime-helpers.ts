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
import type { ChatSessionManagerDeps } from "./chat-session-ports.js";
import type { CliChatEngine, TranscriptRecord } from "./types.js";

/** Resolves after `ms` milliseconds. Used for polling backoff during turn/drain loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
