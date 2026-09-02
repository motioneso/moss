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
 * has returned. A held client that turns out to be broken when reused is not an error: it is
 * dropped and the call is retried once on a fresh connection (measured 8-52ms).
 */
export interface McpClientLike {
  close(): Promise<void>;
}

export interface McpConnectionCache {
  /**
   * Runs `fn` against a live client for this actor+connection, reusing a held one when the quiet
   * window hasn't expired. `connect` is only called when there is no live held client, or when a
   * held one turned out to be broken.
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

  function evictIfExpired(k: string): void {
    const entry = entries.get(k);
    if (!entry) return;
    if (now() - entry.touchedAt <= windowMs) return;
    entries.delete(k);
    if (entry.inFlightCount === 0) closeEntry(entry);
    else entry.expired = true;
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
      evictIfExpired(k);

      const held = entries.get(k) as Entry<C> | undefined;
      if (held) {
        try {
          return await run(held, fn);
        } catch {
          // Held connection turned out to be broken (#2175 Task 9) — not an error, reconnect once.
          entries.delete(k);
          if (held.inFlightCount === 0) closeEntry(held);
          const client = await connect();
          const fresh: Entry<C> = { client, touchedAt: now(), inFlightCount: 0, expired: false };
          entries.set(k, fresh as unknown as Entry<McpClientLike>);
          return run(fresh, fn);
        }
      }

      const client = await connect();
      const fresh: Entry<C> = { client, touchedAt: now(), inFlightCount: 0, expired: false };
      entries.set(k, fresh as unknown as Entry<McpClientLike>);
      return run(fresh, fn);
    }
  };
}

/** Module-level singleton — imported by mcp-client.ts, same closure caveat as callMemory. */
export const mcpConnectionCache: McpConnectionCache = createMcpConnectionCache();
