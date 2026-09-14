import { describe, expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";

import { resolveBriefingFreshness } from "../../packages/briefings/src/freshness.js";

const scopedDb = {} as DataContextDb;
const CAPTURED_AT = new Date("2026-06-28T08:00:00.000Z");
const CAPTURED_ISO = CAPTURED_AT.toISOString();
const EMAIL_SYNC_AT = new Date("2026-06-27T22:00:00.000Z");
const VAULT_AT = new Date("2026-06-25T10:00:00.000Z");

describe("resolveBriefingFreshness", () => {
  it("produces realtime entries for tasks, commitments, chats, goals", async () => {
    const result = await resolveBriefingFreshness(
      scopedDb,
      ["tasks", "commitments", "chats", "goals"],
      CAPTURED_AT,
      {}
    );
    expect(result.version).toBe(1);
    expect(result.capturedAt).toBe(CAPTURED_ISO);
    expect(result.sources).toHaveLength(4);
    for (const entry of result.sources) {
      expect(entry.freshnessKind).toBe("realtime");
      expect(entry.asOf).toBe(CAPTURED_ISO);
    }
  });

  it("resolves email via connectorSyncAt", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["email"], CAPTURED_AT, {
      connectorSyncAt: async () => EMAIL_SYNC_AT
    });
    const entry = result.sources.find((s) => s.source === "email")!;
    expect(entry.freshnessKind).toBe("connector_sync");
    expect(entry.asOf).toBe(EMAIL_SYNC_AT.toISOString());
  });

  it("resolves vault via vaultLastWriteAt", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["vault"], CAPTURED_AT, {
      vaultLastWriteAt: async () => VAULT_AT
    });
    const entry = result.sources.find((s) => s.source === "vault")!;
    expect(entry.freshnessKind).toBe("vault_write");
    expect(entry.asOf).toBe(VAULT_AT.toISOString());
  });

  it("returns asOf: null when connectorSyncAt is absent", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["email"], CAPTURED_AT, {});
    expect(result.sources.find((s) => s.source === "email")!.asOf).toBeNull();
  });

  it("returns asOf: null when connectorSyncAt returns null", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["calendar"], CAPTURED_AT, {
      connectorSyncAt: async () => null
    });
    expect(result.sources.find((s) => s.source === "calendar")!.asOf).toBeNull();
  });

  it("returns asOf: null when connectorSyncAt throws", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["email"], CAPTURED_AT, {
      connectorSyncAt: async () => {
        throw new Error("boom");
      }
    });
    expect(result.sources.find((s) => s.source === "email")!.asOf).toBeNull();
  });

  it("returns asOf: null when vaultLastWriteAt is absent", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["vault"], CAPTURED_AT, {});
    expect(result.sources.find((s) => s.source === "vault")!.asOf).toBeNull();
  });

  it("handles mixed section keys in one call", async () => {
    const result = await resolveBriefingFreshness(
      scopedDb,
      ["email", "tasks", "vault"],
      CAPTURED_AT,
      {
        connectorSyncAt: async () => EMAIL_SYNC_AT,
        vaultLastWriteAt: async () => VAULT_AT
      }
    );
    expect(result.sources).toHaveLength(3);
    expect(result.sources.find((s) => s.source === "email")!.asOf).toBe(
      EMAIL_SYNC_AT.toISOString()
    );
    expect(result.sources.find((s) => s.source === "tasks")!.asOf).toBe(CAPTURED_ISO);
    expect(result.sources.find((s) => s.source === "vault")!.asOf).toBe(VAULT_AT.toISOString());
  });
});

describe("resolveBriefingFreshness — module_cache (T10)", () => {
  it("returns module_cache with the evidence captured time for sports and news", async () => {
    const asOf = "2026-07-01T18:00:00.000Z";
    const result = await resolveBriefingFreshness(
      scopedDb,
      ["sports", "news", "tasks"],
      CAPTURED_AT,
      {
        moduleCapturedAt: { sports: asOf, news: asOf }
      }
    );
    expect(result.sources.find((s) => s.source === "sports")).toEqual({
      source: "sports",
      freshnessKind: "module_cache",
      asOf
    });
    expect(result.sources.find((s) => s.source === "news")).toEqual({
      source: "news",
      freshnessKind: "module_cache",
      asOf
    });
    expect(result.sources.find((s) => s.source === "tasks")?.freshnessKind).toBe("realtime");
  });

  it("returns asOf null when the evidence block was dropped", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["sports"], CAPTURED_AT, {
      moduleCapturedAt: { sports: null }
    });
    expect(result.sources.find((s) => s.source === "sports")).toEqual({
      source: "sports",
      freshnessKind: "module_cache",
      asOf: null
    });
  });

  it("falls through to realtime for sports/news with no evidence entry", async () => {
    const result = await resolveBriefingFreshness(scopedDb, ["sports", "news"], CAPTURED_AT, {});
    for (const entry of result.sources) {
      expect(entry.freshnessKind).toBe("realtime");
      expect(entry.asOf).toBe(CAPTURED_ISO);
    }
  });
});
