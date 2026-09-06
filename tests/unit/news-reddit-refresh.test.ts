/**
 * #2282 Task 1.7: `readSubredditsBounded`'s concurrency gates, request cap, deadline, and
 * one-retry rate-limit policy. Collector-level mapping of the results into candidates is covered
 * in `tests/unit/news-candidates.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REDDIT_REFRESH_LIMITS,
  readSubredditsBounded
} from "../../packages/news/src/compilation/reddit-refresh.js";

function atomFeed(name: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<category term="${name}" label="r/${name}"/><title>Test</title><subtitle>Testing</subtitle>` +
    `</feed>`
  );
}

function okAtom(name: string) {
  return {
    ok: true as const,
    status: 200,
    finalUrl: `https://www.reddit.com/r/${name}/hot.rss`,
    contentType: "application/atom+xml",
    body: atomFeed(name),
    truncated: false
  };
}

describe("readSubredditsBounded", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs more than the concurrent-subreddit limit at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const names = Array.from({ length: 8 }, (_, i) => `sub${i}`);
    const fetch = async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const name = /r\/([^/]+)\//.exec(url)?.[1] ?? "unknown";
      return okAtom(name);
    };

    await readSubredditsBounded(fetch, names, { now: () => 0 });

    expect(maxInFlight).toBeLessThanOrEqual(REDDIT_REFRESH_LIMITS.maxConcurrentHostFetches);
  }, 10_000);

  it("resolves unreachable without calling fetch once the request cap is hit", async () => {
    let calls = 0;
    const names = Array.from(
      { length: REDDIT_REFRESH_LIMITS.maxRequests + 5 },
      (_, i) => `sub${i}`
    );
    const fetch = async (url: string) => {
      calls += 1;
      const name = /r\/([^/]+)\//.exec(url)?.[1] ?? "unknown";
      return okAtom(name);
    };

    const results = await readSubredditsBounded(fetch, names, { now: () => 0 });

    expect(calls).toBeLessThanOrEqual(REDDIT_REFRESH_LIMITS.maxRequests);
    const failed = [...results.values()].filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    for (const failure of failed) {
      expect(failure).toMatchObject({ ok: false, reason: "unreachable" });
    }
  });

  it("resolves unreachable without calling fetch once the deadline has passed", async () => {
    let calls = 0;
    const fetch = async (url: string) => {
      calls += 1;
      const name = /r\/([^/]+)\//.exec(url)?.[1] ?? "unknown";
      return okAtom(name);
    };
    // The first `now()` call computes the deadline (treated as time zero); every call after that
    // simulates time having already run past it, without needing real or fake elapsed time.
    let nowCalls = 0;
    const now = () => (nowCalls++ === 0 ? 0 : REDDIT_REFRESH_LIMITS.deadlineMs + 1);

    const results = await readSubredditsBounded(fetch, ["late"], { now });

    expect(calls).toBe(0);
    expect(results.get("late")).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("retries exactly once on a rate-limited failure with a valid Retry-After", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false as const, reason: "rate_limited" as const, retryAfter: "2" };
      }
      return okAtom("test");
    });

    const start = Date.now();
    const resultsPromise = readSubredditsBounded(fetch, ["test"], { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(2_000);
    const results = await resultsPromise;

    expect(calls).toBe(2);
    expect(results.get("test")).toMatchObject({ ok: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(2_000);
  });

  it("does not retry when Retry-After exceeds 5 seconds or would cross the deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return { ok: false as const, reason: "rate_limited" as const, retryAfter: "6" };
    });

    const resultsPromise = readSubredditsBounded(fetch, ["test"], { now: () => Date.now() });
    await vi.runAllTimersAsync();
    const results = await resultsPromise;

    expect(calls).toBe(1);
    expect(results.get("test")).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});
