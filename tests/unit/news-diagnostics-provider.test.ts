import { dataContextBrand, type DataContextDb } from "@moss/db";
import type { NewsRefreshDiagnostics } from "@moss/news";
import { describe, expect, it } from "vitest";

import { createNewsDiagnosticsProvider } from "@moss/news";

const scopedDb = { [dataContextBrand]: true } as DataContextDb;

function diagnostics(patch: Partial<NewsRefreshDiagnostics> = {}): NewsRefreshDiagnostics {
  return {
    refresh: {
      state: "idle",
      updatedAt: "2026-08-27T10:00:00.000Z",
      lastRequestedAt: "2026-08-27T09:00:00.000Z",
      lastAttemptAt: "2026-08-27T09:01:00.000Z",
      lastSuccessAt: "2026-08-27T09:02:00.000Z",
      lastFailureAt: null,
      lastFailureKind: null,
      ...patch.refresh
    },
    requestedGeneration: 3,
    compiledGeneration: 3,
    snapshotCompiledAt: "2026-08-27T09:02:00.000Z",
    snapshotExpiresAt: "2026-08-28T09:02:00.000Z",
    snapshotAgeSeconds: 60,
    itemCount: 4,
    ...patch
  };
}

describe("news diagnostics provider", () => {
  it("reports unknown before the first refresh", async () => {
    const provider = createNewsDiagnosticsProvider({
      readRefreshDiagnostics: async () =>
        diagnostics({
          refresh: {
            state: "idle",
            updatedAt: null,
            lastRequestedAt: null,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastFailureKind: null
          },
          snapshotCompiledAt: null,
          snapshotExpiresAt: null,
          snapshotAgeSeconds: null,
          itemCount: 0
        })
    });

    await expect(
      provider.observe(scopedDb, { actorUserId: "user-a", requestId: "req-1" })
    ).resolves.toMatchObject({
      status: "unknown",
      summary: "News has never been refreshed for this account."
    });
  });

  it("reports the item count and health without exposing article content", async () => {
    const provider = createNewsDiagnosticsProvider({
      readRefreshDiagnostics: async () => diagnostics({ itemCount: 12 })
    });

    const result = await provider.observe(scopedDb, { actorUserId: "user-a", requestId: "req-1" });
    expect(result).toMatchObject({ status: "ok", facts: { itemCount: 12 } });
    expect(JSON.stringify(result)).not.toContain("article");
  });

  it("marks a stale snapshot as degraded and a newer failure as failed", async () => {
    const stale = createNewsDiagnosticsProvider({
      readRefreshDiagnostics: async () => diagnostics({ snapshotAgeSeconds: 86401 })
    });
    const failed = createNewsDiagnosticsProvider({
      readRefreshDiagnostics: async () =>
        diagnostics({
          refresh: {
            state: "idle",
            updatedAt: "2026-08-27T10:00:00.000Z",
            lastRequestedAt: "2026-08-27T09:00:00.000Z",
            lastAttemptAt: "2026-08-27T11:00:00.000Z",
            lastSuccessAt: "2026-08-27T09:02:00.000Z",
            lastFailureAt: "2026-08-27T11:01:00.000Z",
            lastFailureKind: "fetch"
          }
        })
    });

    await expect(
      stale.observe(scopedDb, { actorUserId: "user-a", requestId: "req-1" })
    ).resolves.toMatchObject({ status: "degraded" });
    await expect(
      failed.observe(scopedDb, { actorUserId: "user-a", requestId: "req-1" })
    ).resolves.toMatchObject({
      status: "failed",
      summary: "News refresh failed while fetching news."
    });
  });
});
