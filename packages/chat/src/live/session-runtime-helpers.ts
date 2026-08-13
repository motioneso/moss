/**
 * Small, self-contained helpers factored out of `chat-session-manager.ts` to keep that file
 * under the repo's file-size gate (`scripts/check-file-size.ts`, 1000-line cap). No behavior
 * change from the code they replace — pure extraction.
 */

import { parseSurfaceSessionKey } from "./chat-surface.js";

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
