/**
 * #2282 Task 1.7: bounded batch reads of several subreddits for the collector. Reddit calls all
 * hit the same host, so two gates apply at once: at most `maxConcurrentSubreddits` subreddit reads
 * in flight, and within that, at most `maxConcurrentHostFetches` underlying HTTP requests in
 * flight. A shared request counter and a 12-second-from-start deadline bound total work; a
 * `rate_limited` failure retries once, only when Reddit's own Retry-After header is present, valid,
 * at most 5 seconds, and still leaves time before the deadline.
 */
import type { NewsFetchOptions, NewsFetchPort, NewsSafeFetchFailure } from "../discovery/ports.js";
import { readSubreddit, type ReadSubredditResult } from "../source/reddit-reader.js";

export const REDDIT_REFRESH_LIMITS = {
  maxConcurrentSubreddits: 4,
  maxConcurrentHostFetches: 2,
  maxRequests: 30,
  deadlineMs: 12_000,
  maxRetryAfterSeconds: 5
} as const;

export interface ReadSubredditsBoundedOptions {
  /** Injectable clock so tests can drive the deadline under fake timers. */
  readonly now?: () => number;
}

type FetchOutcome = Awaited<ReturnType<NewsFetchPort>>;

/** The Retry-After delay to wait before one retry, or null when the failure isn't retryable. */
function retryDelayMs(failure: NewsSafeFetchFailure, remainingMs: number): number | null {
  if (failure.reason !== "rate_limited" || !failure.retryAfter) return null;
  const seconds = Number(failure.retryAfter);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > REDDIT_REFRESH_LIMITS.maxRetryAfterSeconds
  ) {
    return null;
  }
  const delayMs = seconds * 1000;
  return delayMs < remainingMs ? delayMs : null;
}

/**
 * Reads every named subreddit through `fetch`, honoring both concurrency gates, the shared
 * request cap, the deadline, and the one-retry rate-limit policy. Names that fail to read still
 * get an entry in the returned map (a failure result), so the caller can tell "not attempted"
 * (name absent — never happens here) from "attempted and failed".
 */
export async function readSubredditsBounded(
  fetch: NewsFetchPort,
  names: readonly string[],
  opts: ReadSubredditsBoundedOptions = {}
): Promise<Map<string, ReadSubredditResult>> {
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + REDDIT_REFRESH_LIMITS.deadlineMs;
  let requestCount = 0;
  let hostSlotsInUse = 0;
  const hostQueue: Array<() => void> = [];

  function acquireHostSlot(): Promise<void> {
    if (hostSlotsInUse < REDDIT_REFRESH_LIMITS.maxConcurrentHostFetches) {
      hostSlotsInUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => hostQueue.push(resolve));
  }

  function releaseHostSlot(): void {
    const next = hostQueue.shift();
    if (next) next();
    else hostSlotsInUse -= 1;
  }

  async function callFetch(url: string, options: NewsFetchOptions): Promise<FetchOutcome> {
    requestCount += 1;
    await acquireHostSlot();
    try {
      return await fetch(url, { ...options, timeoutMs: Math.max(0, deadline - now()) });
    } finally {
      releaseHostSlot();
    }
  }

  async function boundedFetch(url: string, options: NewsFetchOptions): Promise<FetchOutcome> {
    if (now() >= deadline || requestCount >= REDDIT_REFRESH_LIMITS.maxRequests) {
      return { ok: false, reason: "network" };
    }
    const first = await callFetch(url, options);
    if (first.ok) return first;
    const delay = retryDelayMs(first, deadline - now());
    if (delay === null || requestCount >= REDDIT_REFRESH_LIMITS.maxRequests) return first;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    if (now() >= deadline) return first;
    return callFetch(url, options);
  }

  const results = new Map<string, ReadSubredditResult>();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= names.length) return;
      const name = names[index]!;
      results.set(name, await readSubreddit(boundedFetch, name));
    }
  }

  const workerCount = Math.min(REDDIT_REFRESH_LIMITS.maxConcurrentSubreddits, names.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
