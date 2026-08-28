// #1319 Task B: exercises createModuleDistributionPort's registry-index cache directly
// (no DB, no real network) — same fakeFetch pattern as
// tests/unit/module-distribution-pipeline.test.ts. Proves the atomic-snapshot cache
// invariant from the plan: one fetchRegistryIndex call produces entries + verification +
// digest together, a cache hit returns the exact same snapshot object, and a failed
// refetch never overwrites a previously-cached good snapshot.
import { describe, expect, it, vi } from "vitest";

import type { FastifyInstance } from "fastify";

import { createModuleDistributionPort } from "../../apps/api/src/module-distribution-port.js";
import type { ApiServerConfig } from "../../apps/api/src/server.js";

const goodIndex = {
  schemaVersion: 1,
  generatedAt: "2026-07-12T00:00:00.000Z",
  modules: []
};

const fakeServer = { log: { warn: vi.fn(), error: vi.fn() } } as unknown as Pick<
  FastifyInstance,
  "log"
>;

const fakeApiServerConfig: ApiServerConfig = {
  host: "127.0.0.1",
  port: 0,
  mcpServerUrl: "http://127.0.0.1:0",
  externalModulesDir: "/tmp/module-distribution-port-test-unused"
};

/** index.json.sig 404s every time — verification always resolves "unverified", never "unavailable" (index still parses). */
function fakeFetchOk(): typeof fetch {
  return (async (url: string | URL) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.endsWith(".sig")) return new Response("not found", { status: 404 });
    if (href.endsWith("/index.json")) {
      return new Response(JSON.stringify(goodIndex), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
}

function fakeFetchFailing(): typeof fetch {
  return (async () => new Response("gone", { status: 404 })) as typeof fetch;
}

describe("createModuleDistributionPort registry cache", () => {
  it("returns the identical cached snapshot object on a second refresh:false call, fetching once", async () => {
    const fetchFn = vi.fn(fakeFetchOk());
    const port = createModuleDistributionPort(fakeServer, fakeApiServerConfig, {
      fetchFn: fetchFn as unknown as typeof fetch
    });

    const first = await port.fetchRegistryEntries({ refresh: false });
    const second = await port.fetchRegistryEntries({ refresh: false });

    expect(second).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(2); // index.json + index.json.sig, once total
  });

  it("refresh:true bypasses the cache and fetches again", async () => {
    const fetchFn = vi.fn(fakeFetchOk());
    const port = createModuleDistributionPort(fakeServer, fakeApiServerConfig, {
      fetchFn: fetchFn as unknown as typeof fetch
    });

    const first = await port.fetchRegistryEntries({ refresh: false });
    const callsAfterFirst = fetchFn.mock.calls.length;
    const second = await port.fetchRegistryEntries({ refresh: true });

    expect(fetchFn.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("never overwrites a previously-cached good snapshot with a failed refetch", async () => {
    let useFailing = false;
    const fetchFn = vi.fn(((url: string | URL, init?: RequestInit) => {
      if (useFailing) return fakeFetchFailing()(url, init);
      return fakeFetchOk()(url, init);
    }) as typeof fetch);
    const port = createModuleDistributionPort(fakeServer, fakeApiServerConfig, {
      fetchFn: fetchFn as unknown as typeof fetch
    });

    const good = await port.fetchRegistryEntries({ refresh: false });
    expect(good.entries).not.toBeNull();

    useFailing = true;
    const failed = await port.fetchRegistryEntries({ refresh: true });
    expect(failed.entries).toBeNull();
    expect(failed.catalogVerification).toBe("unavailable");

    // Cache was left untouched by the failed refetch — a plain refresh:false call
    // still serves the last good snapshot, not the failure.
    useFailing = false; // if the cache were consulted correctly, fetchFn shouldn't even run
    const stillGood = await port.fetchRegistryEntries({ refresh: false });
    expect(stillGood).toBe(good);
  });
});
