import { describe, expect, it } from "vitest";

import {
  createDatasetClient,
  HostPinnedFetchError,
  HostPinningViolationError
} from "@moss/datasets";
import type { DatasetLogger } from "@moss/datasets";
import type {
  ExternalSourceAdapter,
  ExternalSourceAdapterContext,
  ModuleExternalSourceManifest
} from "@moss/module-sdk";

function fakeLogger(): {
  logger: DatasetLogger;
  warnings: Array<[Record<string, unknown>, string]>;
} {
  const warnings: Array<[Record<string, unknown>, string]> = [];
  return { logger: { warn: (data, message) => warnings.push([data, message]) }, warnings };
}

function source(
  overrides: Partial<ModuleExternalSourceManifest> = {}
): ModuleExternalSourceManifest {
  return {
    id: "fixture",
    displayName: "Fixture Source",
    credential: "none",
    fetchHosts: ["example.com"],
    datasets: [{ key: "widgets", ttlMs: 1_000, staleness: "degrade-empty" }],
    ...overrides
  };
}

function adapterFrom(
  fn: (datasetKey: string, params: Record<string, unknown>) => Promise<unknown>
): ExternalSourceAdapter {
  return {
    fetchDataset: (datasetKey, params, _ctx: ExternalSourceAdapterContext) => fn(datasetKey, params)
  };
}

function adapterCallingFetch(url: string): ExternalSourceAdapter {
  return {
    fetchDataset: async (_datasetKey, _params, ctx: ExternalSourceAdapterContext) => {
      const res = await ctx.fetchFn(url);
      return res.json();
    }
  };
}

describe("createDatasetClient", () => {
  it("rejects credential: api-key defensively", () => {
    expect(() =>
      createDatasetClient(
        source({ credential: "api-key" }),
        adapterFrom(async () => ({}))
      )
    ).toThrow(/api-key/);
  });

  it("throws for a datasetKey not declared on the source", async () => {
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => ({}))
    );
    await expect(client.getDataset("nope", {}, { fallback: null })).rejects.toThrow(
      /Unknown dataset "nope"/
    );
  });

  it("fetches fresh data and returns degraded: false", async () => {
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => ({ n: 1 }))
    );
    const envelope = await client.getDataset("widgets", {}, { fallback: null });
    expect(envelope).toMatchObject({ data: { n: 1 }, degraded: false });
  });

  it("serves a cached hit within TTL without calling the adapter again", async () => {
    let calls = 0;
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        calls += 1;
        return { n: calls };
      })
    );
    const first = await client.getDataset("widgets", {}, { fallback: null });
    const second = await client.getDataset("widgets", {}, { fallback: null });
    expect(first.data).toEqual({ n: 1 });
    expect(second.data).toEqual({ n: 1 });
    expect(second.degraded).toBe(false);
    expect(calls).toBe(1);
  });

  it("refetches once TTL has elapsed", async () => {
    let now = 0;
    let calls = 0;
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        calls += 1;
        return { n: calls };
      }),
      { now: () => new Date(now) }
    );
    await client.getDataset("widgets", {}, { fallback: null });
    now = 5_000; // past the 1_000ms ttl
    const second = await client.getDataset("widgets", {}, { fallback: null });
    expect(second.data).toEqual({ n: 2 });
    expect(calls).toBe(2);
  });

  it("degrade-empty dataset falls back to the caller fallback on fetch failure (no cache to serve stale)", async () => {
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        throw new Error("upstream down");
      })
    );
    const envelope = await client.getDataset("widgets", {}, { fallback: { empty: true } });
    expect(envelope).toEqual({
      data: { empty: true },
      degraded: true,
      fetchedAt: expect.any(String)
    });
  });

  it("serve-stale-on-error dataset serves the stale cache entry on fetch failure after TTL expiry, logs outcome: stale-cache", async () => {
    const { logger, warnings } = fakeLogger();
    let now = 0;
    let shouldFail = false;
    const client = createDatasetClient(
      source({
        datasets: [
          {
            key: "widgets",
            ttlMs: 1_000,
            staleness: "serve-stale-on-error",
            staleRetentionMs: 10_000
          }
        ]
      }),
      adapterFrom(async () => {
        if (shouldFail) throw new Error("upstream down");
        return { n: 1 };
      }),
      { now: () => new Date(now), logger }
    );
    const fresh = await client.getDataset("widgets", {}, { fallback: null });
    expect(fresh).toMatchObject({ data: { n: 1 }, degraded: false });

    now = 5_000; // past ttl (1_000) but within staleRetentionMs (10_000 after expiry)
    shouldFail = true;
    const stale = await client.getDataset("widgets", {}, { fallback: null });
    expect(stale).toMatchObject({ data: { n: 1 }, degraded: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({
      sourceId: "fixture",
      datasetKey: "widgets",
      outcome: "stale-cache",
      errorName: "Error"
    });
  });

  it("serve-stale-on-error dataset falls back once past evictAt (staleRetentionMs elapsed)", async () => {
    let now = 0;
    let shouldFail = false;
    const client = createDatasetClient(
      source({
        datasets: [
          {
            key: "widgets",
            ttlMs: 1_000,
            staleness: "serve-stale-on-error",
            staleRetentionMs: 10_000
          }
        ]
      }),
      adapterFrom(async () => {
        if (shouldFail) throw new Error("upstream down");
        return { n: 1 };
      }),
      { now: () => new Date(now) }
    );
    await client.getDataset("widgets", {}, { fallback: "fallback" });

    now = 1_000 + 10_000; // expiresAt (1_000) + staleRetentionMs (10_000) => evicted
    shouldFail = true;
    const result = await client.getDataset("widgets", {}, { fallback: "fallback" });
    expect(result).toMatchObject({ data: "fallback", degraded: true });
  });

  it("builds distinct cache entries per params (order-independent key)", async () => {
    let calls = 0;
    const client = createDatasetClient(
      source(),
      adapterFrom(async (_key, params) => {
        calls += 1;
        return { params, call: calls };
      })
    );
    interface Payload {
      readonly params: unknown;
      readonly call: number;
    }
    const fallback = null as unknown as Payload;
    const a = await client.getDataset<Payload>("widgets", { b: 2, a: 1 }, { fallback });
    const b = await client.getDataset<Payload>("widgets", { a: 1, b: 2 }, { fallback });
    const c = await client.getDataset<Payload>("widgets", { a: 9 }, { fallback });
    expect(a.data).toEqual(b.data); // same params, different key order => same cache key
    expect(calls).toBe(2); // a/b shared a cache entry; c is distinct
    expect(c.data.call).toBe(2);
  });

  it("waits out minIntervalMs rate courtesy between fetches to distinct datasets", async () => {
    // `now` tracks the client's own clock (used for cache TTL math); wall-clock timing is
    // measured separately with performance.now() since waitForRateCourtesy's setTimeout runs
    // against real timers regardless of the injected `now`.
    let now = 0;
    const client = createDatasetClient(
      source({
        fetchHosts: ["example.com"],
        minIntervalMs: 40,
        datasets: [
          { key: "a", ttlMs: 1, staleness: "degrade-empty" },
          { key: "b", ttlMs: 1, staleness: "degrade-empty" }
        ]
      }),
      adapterFrom(async () => ({})),
      { now: () => new Date(now) }
    );
    const start = performance.now();
    await client.getDataset("a", {}, { fallback: null });
    now = 1; // wall-clock elapsed is ~0ms from the client's perspective too
    await client.getDataset("b", {}, { fallback: null });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  it("logs a host-pinning violation with source id + blocked host, still returns degraded", async () => {
    const { logger, warnings } = fakeLogger();
    const client = createDatasetClient(
      source({ fetchHosts: ["site.api.espn.com"] }),
      adapterFrom(async (_key, _params) => {
        throw new HostPinningViolationError(
          "evil.example.com",
          'Dataset runtime host pinning: host "evil.example.com" is not in the allowed list'
        );
      }),
      { logger }
    );
    const envelope = await client.getDataset("widgets", {}, { fallback: { empty: true } });
    expect(envelope).toEqual({
      data: { empty: true },
      degraded: true,
      fetchedAt: expect.any(String)
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({ sourceId: "fixture", host: "evil.example.com" });
  });

  it("logs a sanitized warning for an ordinary (non-pinning) fetch failure, still returns degraded", async () => {
    const { logger, warnings } = fakeLogger();
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        throw new Error("upstream down");
      }),
      { logger }
    );
    const envelope = await client.getDataset("widgets", {}, { fallback: { empty: true } });
    expect(envelope).toMatchObject({ data: { empty: true }, degraded: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({
      sourceId: "fixture",
      datasetKey: "widgets",
      outcome: "empty-fallback",
      errorName: "Error"
    });
  });

  it("captures the HostPinnedFetchError code for a non-pinning host-fetch failure", async () => {
    const { logger, warnings } = fakeLogger();
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        throw new HostPinnedFetchError("fetch_timeout");
      }),
      { logger }
    );
    await client.getDataset("widgets", {}, { fallback: { empty: true } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({
      errorName: "HostPinnedFetchError",
      errorCode: "fetch_timeout"
    });
  });

  it("never logs the raw error message, response body, or fallback content", async () => {
    const { logger, warnings } = fakeLogger();
    const client = createDatasetClient(
      source(),
      adapterFrom(async () => {
        throw new Error("upstream down: token=super-secret-value");
      }),
      { logger }
    );
    await client.getDataset(
      "widgets",
      {},
      { fallback: { secretMarker: "fallback-marker-should-not-log" } }
    );
    expect(warnings).toHaveLength(1);
    const serialized = JSON.stringify(warnings[0]);
    expect(serialized).not.toContain("upstream down");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("fallback-marker-should-not-log");
  });

  it("threads fetchTimeoutMs through to the underlying pinned fetch (#858)", async () => {
    const hangingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;

    const client = createDatasetClient(
      source({ fetchHosts: ["example.com"] }),
      adapterCallingFetch("https://example.com/widgets"),
      { fetchFn: hangingFetch, fetchTimeoutMs: 20 }
    );
    const start = performance.now();
    const envelope = await client.getDataset("widgets", {}, { fallback: { empty: true } });
    const elapsed = performance.now() - start;
    expect(envelope).toMatchObject({ data: { empty: true }, degraded: true });
    expect(elapsed).toBeLessThan(150); // well under the 200ms hang → the 20ms timeout fired
  });

  describe("cacheOnly peek (#907)", () => {
    it("returns cacheMiss without calling the adapter on a cold cache", async () => {
      let calls = 0;
      const client = createDatasetClient(
        source(),
        adapterFrom(async () => {
          calls += 1;
          return { n: calls };
        })
      );
      const result = await client.getDataset<string[]>(
        "widgets",
        { competitionKey: "eng.1" },
        { fallback: [], cacheOnly: true }
      );
      expect(result.cacheMiss).toBe(true);
      expect(result.data).toEqual([]);
      expect(result.degraded).toBe(false);
      expect(calls).toBe(0);
    });

    it("serves a fresh cached value without refetching", async () => {
      let calls = 0;
      const client = createDatasetClient(
        source(),
        adapterFrom(async () => {
          calls += 1;
          return { n: calls };
        })
      );
      await client.getDataset("widgets", { competitionKey: "eng.1" }, { fallback: null }); // warm (1 call)
      const result = await client.getDataset(
        "widgets",
        { competitionKey: "eng.1" },
        { fallback: null, cacheOnly: true }
      );
      expect(result.cacheMiss).toBeUndefined();
      expect(result.degraded).toBe(false);
      expect(calls).toBe(1); // no second adapter call
    });

    it("serves a stale-but-retained hit as degraded: true, still without calling the adapter", async () => {
      let now = 0;
      let calls = 0;
      const client = createDatasetClient(
        source({
          datasets: [
            {
              key: "widgets",
              ttlMs: 1_000,
              staleness: "serve-stale-on-error",
              staleRetentionMs: 10_000
            }
          ]
        }),
        adapterFrom(async () => {
          calls += 1;
          return { n: calls };
        }),
        { now: () => new Date(now) }
      );
      await client.getDataset("widgets", {}, { fallback: null }); // warm (1 call)

      now = 5_000; // past ttl (1_000) but within staleRetentionMs (10_000 after expiry)
      const result = await client.getDataset("widgets", {}, { fallback: null, cacheOnly: true });
      expect(result.cacheMiss).toBeUndefined();
      expect(result.degraded).toBe(true);
      expect(result.data).toEqual({ n: 1 });
      expect(calls).toBe(1); // cacheOnly never triggers a live fetch, even on stale entries
    });
  });
});
