/**
 * Holds one connected MCP client per (acting user, connection) for the life of a burst (#2175
 * Task 9), instead of `mcp-client.ts` connecting and closing on every single tool call. Same
 * 30-second quiet window as Task 3's call memory and Task 8's tool-list cache — one number to
 * reason about — but this store holds a live resource, so unlike those two it must actually close
 * what it evicts rather than just letting a stale read fall through.
 *
 * The key starts with the acting user on purpose: a client carries that user's credential, so a
 * held connection must never be reachable by another user's call, ever.
 *
 * A client mid-call is never closed underneath itself — expiry marks the entry and removes it
 * from the map immediately, but the actual `close()` only happens once every in-flight use of it
 * has returned.
 *
 * Reconnect happens ONLY when a held client is found dead before the call is sent (the SDK clears
 * `transport` when the socket drops under it). A failure DURING the call — reply timeout, socket
 * reset mid-request, tool error — is surfaced to the caller as-is and the client is evicted; the
 * call is never re-sent, because the remote may already have performed a side-effecting action
 * (email sent, ticket created) and a blind retry would run it twice. The duplicate-call guard in
 * tool-manifests.ts only sees separate top-level calls, so it cannot catch that case.
 */
export interface McpClientLike {
  close(): Promise<void>;
  /** SDK `Client` exposes this; it becomes `undefined` once the underlying transport has closed. */
  readonly transport?: unknown;
}

export interface McpConnectionCache {
  /**
   * Runs `fn` against a live client for this actor+connection, reusing a held one when the quiet
   * window hasn't expired. `connect` is only called when there is no held client, or when the held
   * one is found dead before the call is sent. A failure during `fn` propagates and is never
   * retried on a fresh connection.
   */
  withClient<C extends McpClientLike, T>(
    actorUserId: string,
    connectionId: string,
    connect: () => Promise<C>,
    fn: (client: C) => Promise<T>
  ): Promise<T>;
}

interface Entry<C extends McpClientLike> {
  client: C;
  touchedAt: number;
  inFlightCount: number;
  expired: boolean;
}

export function createMcpConnectionCache(deps?: {
  now?: () => number;
  windowMs?: number;
}): McpConnectionCache {
  const now = deps?.now ?? (() => Date.now());
  const windowMs = deps?.windowMs ?? 30_000;
  const entries = new Map<string, Entry<McpClientLike>>();

  function key(actorUserId: string, connectionId: string): string {
    return `${actorUserId}::${connectionId}`;
  }

  function closeEntry<C extends McpClientLike>(entry: Entry<C>): void {
    void entry.client.close().catch(() => {});
  }

  /** Removes the entry from the map; the real close waits for any in-flight use to return. */
  function evict(k: string, entry: Entry<McpClientLike>): void {
    if (entries.get(k) === entry) entries.delete(k);
    if (entry.inFlightCount === 0) closeEntry(entry);
    else entry.expired = true;
  }

  /** True while the client can still send: the SDK clears `transport` once the socket has closed. */
  function isLive(client: McpClientLike): boolean {
    return !("transport" in client) || client.transport !== undefined;
  }

  function evictIfExpiredOrDead(k: string): void {
    const entry = entries.get(k);
    if (!entry) return;
    const quiet = now() - entry.touchedAt > windowMs;
    if (!quiet && isLive(entry.client)) return;
    evict(k, entry);
  }

  async function run<C extends McpClientLike, T>(
    entry: Entry<C>,
    fn: (client: C) => Promise<T>
  ): Promise<T> {
    entry.inFlightCount += 1;
    try {
      const result = await fn(entry.client);
      entry.touchedAt = now();
      return result;
    } finally {
      entry.inFlightCount -= 1;
      if (entry.expired && entry.inFlightCount === 0) closeEntry(entry);
    }
  }

  return {
    async withClient<C extends McpClientLike, T>(
      actorUserId: string,
      connectionId: string,
      connect: () => Promise<C>,
      fn: (client: C) => Promise<T>
    ): Promise<T> {
      const k = key(actorUserId, connectionId);
      // The only reconnect path: a held client that is quiet past the window or already dead
      // BEFORE anything is sent on it (#2175 Task 9).
      evictIfExpiredOrDead(k);

      let entry = entries.get(k) as Entry<C> | undefined;
      if (!entry) {
        const client = await connect();
        entry = { client, touchedAt: now(), inFlightCount: 0, expired: false };
        entries.set(k, entry as unknown as Entry<McpClientLike>);
      }

      try {
        return await run(entry, fn);
      } catch (err) {
        // A failure DURING the call is never retried: the remote may already have acted on it.
        // Drop the connection so the next call starts clean, and let the caller see the error.
        evict(k, entry as unknown as Entry<McpClientLike>);
        throw err;
      }
    }
  };
}

/** Module-level singleton — imported by mcp-client.ts, same closure caveat as callMemory. */
export const mcpConnectionCache: McpConnectionCache = createMcpConnectionCache();
