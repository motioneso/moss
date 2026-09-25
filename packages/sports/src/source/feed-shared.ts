// Shared fetch budget and per-host limiter for the public feed paths: the custom-source reader
// (public-source-reader.ts), its article-photo pass (photo-pass.ts), and the fixed catalog feeds
// for news-only competitions (catalog-feed.ts). Split out so catalog-feed can reuse them without
// importing the reader back (which would form an import cycle).

export const MAX_RESPONSE_BYTES = 1_000_000;
export const FETCH_TIMEOUT_MS = 6_000;
export const REFRESH_DEADLINE_MS = 12_000;
export const HEADLINE_TTL_MS = 10 * 60 * 1000;
const MAX_DOMAIN_CONCURRENCY = 2;

/**
 * Caps concurrent requests per host for one refresh. Insertion order is not meaningful; the map
 * just tracks how many requests each host currently has in flight and who is waiting.
 */
export class DomainConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async acquireAll(
    hosts: readonly string[],
    deadline: number,
    now: () => number,
    signal?: AbortSignal
  ): Promise<readonly string[] | null> {
    const acquired: string[] = [];
    for (const host of [...new Set(hosts.map((value) => value.toLowerCase()))].sort()) {
      if (!(await this.acquire(host, deadline, now, signal))) {
        for (const held of acquired.reverse()) this.release(held);
        return null;
      }
      acquired.push(host);
    }
    return acquired;
  }

  private acquire(
    host: string,
    deadline: number,
    now: () => number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if ((this.active.get(host) ?? 0) < MAX_DOMAIN_CONCURRENCY) {
      this.active.set(host, (this.active.get(host) ?? 0) + 1);
      return Promise.resolve(true);
    }
    if (signal?.aborted || now() >= deadline) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const queue = this.waiters.get(host) ?? [];
      const grant = (): void => finish(true);
      const finish = (granted: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const current = this.waiters.get(host);
        const index = current?.indexOf(grant) ?? -1;
        if (current && index >= 0) current.splice(index, 1);
        if (current?.length === 0) this.waiters.delete(host);
        if (granted) this.active.set(host, (this.active.get(host) ?? 0) + 1);
        resolve(granted);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(1, deadline - now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(grant);
      this.waiters.set(host, queue);
    });
  }

  release(host: string): void {
    const count = this.active.get(host) ?? 0;
    if (count <= 1) this.active.delete(host);
    else this.active.set(host, count - 1);
    const next = this.waiters.get(host)?.shift();
    if (this.waiters.get(host)?.length === 0) this.waiters.delete(host);
    next?.();
  }
}
