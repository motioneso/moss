/**
 * Plan 3.6b (#2890): embedding activity is recorded once per job (per provider instance), not per
 * chunk, through the injectable sink. Only transport facts are recorded; no text enters the row.
 */
import { describe, expect, it, vi } from "vitest";

import {
  installEmbeddingActivityRecorder,
  withEmbeddingActivity,
  type EmbeddingActivityEntry
} from "../../packages/memory/src/embedding-provider-config.js";
import type { EmbeddingProvider } from "../../packages/memory/src/embedding-provider.js";

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    dimensions: 3,
    modelName: "embed-test-model",
    modelVersion: "1",
    embedDocument: vi.fn(async () => [1, 2, 3]),
    embedQuery: vi.fn(async () => [1, 2, 3]),
    ...overrides
  };
}

describe("embedding model activity recording (plan 3.6b, #2890)", () => {
  it("records exactly one row for many chunks in one job", async () => {
    const entries: EmbeddingActivityEntry[] = [];
    const provider = withEmbeddingActivity(fakeProvider(), (entry) => entries.push(entry));

    await provider.embedDocument("chunk one");
    await provider.embedDocument("chunk two");
    await provider.embedQuery("a query");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "embedding",
      action: "embedding",
      outcome: "ok",
      modelName: "embed-test-model",
      result: "completed"
    });
  });

  it("records an error row when the embedding call fails, and never the text", async () => {
    const SENTINEL = "SENTINEL-embedding-text-do-not-record";
    const entries: EmbeddingActivityEntry[] = [];
    const provider = withEmbeddingActivity(
      fakeProvider({
        embedDocument: vi.fn(async () => {
          throw new Error("embedding backend down");
        })
      }),
      (entry) => entries.push(entry)
    );

    await expect(provider.embedDocument(SENTINEL)).rejects.toThrow("embedding backend down");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "error", result: "failed" });
    expect(JSON.stringify(entries)).not.toContain(SENTINEL);
  });

  it("records through the installed sink by default, and a throwing sink never fails the call", async () => {
    const entries: EmbeddingActivityEntry[] = [];
    installEmbeddingActivityRecorder((entry) => entries.push(entry));
    try {
      const provider = withEmbeddingActivity(fakeProvider());
      await provider.embedDocument("chunk");
      expect(entries).toHaveLength(1);
    } finally {
      installEmbeddingActivityRecorder(null);
    }

    // A sink that throws must not change the returned value.
    installEmbeddingActivityRecorder(() => {
      throw new Error("sink exploded");
    });
    try {
      const provider = withEmbeddingActivity(fakeProvider());
      await expect(provider.embedDocument("chunk")).resolves.toEqual([1, 2, 3]);
    } finally {
      installEmbeddingActivityRecorder(null);
    }
  });
});
