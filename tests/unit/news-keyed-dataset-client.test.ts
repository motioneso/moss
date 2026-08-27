import { describe, expect, it } from "vitest";

import {
  createKeyedDatasetClient,
  KeyedCredentialUnavailableError,
  type DatasetLogger,
  type KeyedCredentialLookup,
  type KeyedCredentialLookupResult,
  type KeyedSourceDeclaration
} from "@moss/datasets";
import type { ExternalSourceAdapter, ExternalSourceAdapterContext } from "@moss/module-sdk";

function declaration(overrides: Partial<KeyedSourceDeclaration> = {}): KeyedSourceDeclaration {
  return {
    id: "fixture-connection",
    fetchHosts: ["fixture.example"],
    timeoutMs: 4_000,
    maxResponseBytes: 65_536,
    minIntervalMs: 0,
    datasets: [{ key: "headlines", ttlMs: 60_000 }],
    ...overrides
  };
}

function fakeLogger(): {
  logger: DatasetLogger;
  warnings: Array<[Record<string, unknown>, string]>;
} {
  const warnings: Array<[Record<string, unknown>, string]> = [];
  return { logger: { warn: (data, message) => warnings.push([data, message]) }, warnings };
}

/** Records what the adapter was handed, including the plaintext key, so tests can assert on it. */
function recordingAdapter(result: unknown = ["item"]): {
  adapter: ExternalSourceAdapter;
  calls: Array<{ datasetKey: string; params: Record<string, unknown>; apiKey: string | undefined }>;
} {
  const calls: Array<{
    datasetKey: string;
    params: Record<string, unknown>;
    apiKey: string | undefined;
  }> = [];
  return {
    adapter: {
      fetchDataset: async (
        datasetKey: string,
        params: Record<string, unknown>,
        ctx: ExternalSourceAdapterContext
      ) => {
        calls.push({ datasetKey, params, apiKey: ctx.apiKey });
        if (result instanceof Error) throw result;
        return result;
      }
    },
    calls
  };
}

function lookupReturning(...results: KeyedCredentialLookupResult[]): {
  lookup: KeyedCredentialLookup<null>;
  calls: number;
} {
  const state = { calls: 0 };
  const lookup: KeyedCredentialLookup<null> = async () => {
    const next = results[Math.min(state.calls, results.length - 1)]!;
    state.calls += 1;
    return next;
  };
  return {
    lookup,
    get calls() {
      return state.calls;
    }
  };
}

const OK = (apiKey: string, generation: string): KeyedCredentialLookupResult => ({
  ok: true,
  apiKey,
  generation
});

function request(actorUserId: string, sourceId = "source-1") {
  return {
    actorUserId,
    sourceId,
    datasetKey: "headlines",
    params: { topicKey: "world" },
    credentialContext: null
  };
}

describe("keyed dataset client — cache identity", () => {
  it("never serves one person's cached answer to another", async () => {
    const { adapter, calls } = recordingAdapter();
    const client = createKeyedDatasetClient(declaration(), adapter, async ({ actorUserId }) =>
      OK(`key-for-${actorUserId}`, "1")
    );

    await client.getDataset(request("user-a"));
    await client.getDataset(request("user-b"));

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.apiKey)).toEqual(["key-for-user-a", "key-for-user-b"]);
  });

  it("serves the same person the same answer from cache", async () => {
    const { adapter, calls } = recordingAdapter();
    const client = createKeyedDatasetClient(declaration(), adapter, async () => OK("k", "1"));

    const first = await client.getDataset(request("user-a"));
    const second = await client.getDataset(request("user-a"));

    expect(calls).toHaveLength(1);
    expect(second.data).toEqual(first.data);
    expect(second.cached).toBe(true);
    expect(first.cached).toBe(false);
  });

  it("keeps two source rows apart for the same person", async () => {
    const { adapter, calls } = recordingAdapter();
    const client = createKeyedDatasetClient(declaration(), adapter, async () => OK("k", "1"));

    await client.getDataset(request("user-a", "source-1"));
    await client.getDataset(request("user-a", "source-2"));

    expect(calls).toHaveLength(2);
  });

  it("makes the earlier answer unreachable once the key generation moves on", async () => {
    const { adapter, calls } = recordingAdapter();
    let generation = "1";
    const client = createKeyedDatasetClient(declaration(), adapter, async () =>
      OK("k", generation)
    );

    await client.getDataset(request("user-a"));
    expect(calls).toHaveLength(1);

    generation = "2";
    await client.getDataset(request("user-a"));
    expect(calls).toHaveLength(2);
  });
});

describe("keyed dataset client — failing closed", () => {
  it.each(["missing", "revoked", "unreadable"] as const)(
    "refuses to fetch when the key is %s, and never calls the adapter",
    async (reason) => {
      const { adapter, calls } = recordingAdapter();
      const client = createKeyedDatasetClient(declaration(), adapter, async () => ({
        ok: false,
        reason
      }));

      await expect(client.getDataset(request("user-a"))).rejects.toBeInstanceOf(
        KeyedCredentialUnavailableError
      );
      expect(calls).toHaveLength(0);
    }
  );

  it("stops serving a cached answer as soon as the key is revoked", async () => {
    const { adapter, calls } = recordingAdapter();
    const results: KeyedCredentialLookupResult[] = [OK("k", "1"), { ok: false, reason: "revoked" }];
    let call = 0;
    const client = createKeyedDatasetClient(
      declaration(),
      adapter,
      async () => results[Math.min(call++, results.length - 1)]!
    );

    await client.getDataset(request("user-a"));
    expect(calls).toHaveLength(1);

    await expect(client.getDataset(request("user-a"))).rejects.toBeInstanceOf(
      KeyedCredentialUnavailableError
    );
    expect(calls).toHaveLength(1);
  });

  it("rejects an unknown dataset key before looking the credential up", async () => {
    const { adapter } = recordingAdapter();
    const seen = lookupReturning(OK("k", "1"));
    const client = createKeyedDatasetClient(declaration(), adapter, seen.lookup);

    await expect(
      client.getDataset({ ...request("user-a"), datasetKey: "not-declared" })
    ).rejects.toThrow(/dataset/i);
    expect(seen.calls).toBe(0);
  });

  it("passes a fetch failure to the caller rather than degrading to an empty answer", async () => {
    const { adapter } = recordingAdapter(new Error("upstream exploded"));
    const client = createKeyedDatasetClient(declaration(), adapter, async () => OK("k", "1"));

    await expect(client.getDataset(request("user-a"))).rejects.toThrow();
  });
});

describe("keyed dataset client — the plaintext key", () => {
  it("hands the key to the adapter and keeps it out of the cached value", async () => {
    const { adapter, calls } = recordingAdapter({ headlines: ["one"] });
    const client = createKeyedDatasetClient(declaration(), adapter, async () =>
      OK("super-secret-key", "1")
    );

    const envelope = await client.getDataset(request("user-a"));

    expect(calls[0]?.apiKey).toBe("super-secret-key");
    expect(JSON.stringify(envelope)).not.toContain("super-secret-key");
  });
});

describe("keyed dataset client — bounds and logging", () => {
  it("hands the declared timeout and response cap to the pinned fetch builder", async () => {
    const seen: Array<{ hosts: readonly string[]; timeoutMs?: number; maxResponseBytes?: number }> =
      [];
    const { adapter } = recordingAdapter();
    const client = createKeyedDatasetClient(
      declaration({ timeoutMs: 7_777, maxResponseBytes: 4_242 }),
      adapter,
      async () => OK("k", "1"),
      {
        createFetch: (hosts, options) => {
          seen.push({
            hosts,
            timeoutMs: options.timeoutMs,
            maxResponseBytes: options.maxResponseBytes
          });
          return (async () => new Response("{}")) as unknown as typeof fetch;
        }
      }
    );

    await client.getDataset(request("user-a"));

    expect(seen[0]).toEqual({
      hosts: ["fixture.example"],
      timeoutMs: 7_777,
      maxResponseBytes: 4_242
    });
  });

  it("waits out the declared minimum gap between two fetches", async () => {
    const { adapter, calls } = recordingAdapter();
    const client = createKeyedDatasetClient(
      declaration({ minIntervalMs: 60, datasets: [{ key: "headlines", ttlMs: 0 }] }),
      adapter,
      async () => OK("k", "1")
    );

    await client.getDataset(request("user-a"));
    expect(calls).toHaveLength(1);

    const startedAt = Date.now();
    await client.getDataset(request("user-a"));
    expect(calls).toHaveLength(2);
    // The second fetch cannot have gone out immediately; the declared gap is real, not advisory.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it("logs only the source, dataset, outcome and error class on a fetch failure", async () => {
    const { logger, warnings } = fakeLogger();
    const { adapter } = recordingAdapter(new Error("https://newsapi.org/?apiKey=leaked"));
    const client = createKeyedDatasetClient(
      declaration(),
      adapter,
      async () => OK("super-secret-key", "1"),
      { logger }
    );

    await expect(client.getDataset(request("user-a"))).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    const [data] = warnings[0]!;
    expect(Object.keys(data).sort()).toEqual(["datasetKey", "errorName", "outcome", "sourceId"]);
    expect(JSON.stringify(warnings)).not.toContain("super-secret-key");
    expect(JSON.stringify(warnings)).not.toContain("leaked");
  });

  it("logs the credential outcome without naming the user or the key", async () => {
    const { logger, warnings } = fakeLogger();
    const { adapter } = recordingAdapter();
    const client = createKeyedDatasetClient(
      declaration(),
      adapter,
      async () => ({ ok: false, reason: "revoked" }),
      { logger }
    );

    await expect(client.getDataset(request("user-a"))).rejects.toBeInstanceOf(
      KeyedCredentialUnavailableError
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("user-a");
  });
});
