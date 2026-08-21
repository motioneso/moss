import { describe, expect, it, vi } from "vitest";

import { createIsModuleEnabled } from "../../apps/worker/src/worker-module-gate.js";
import type { ExternalModuleDiscovery } from "@moss/module-registry";

// #1753 Task 9 — the worker's module-active gate treats a draft as always enabled (exempt from
// the manifest/package hash check reconcile.ts already exempts drafts from), while keeping the
// existing exact-hash-match requirement for a shipped, enabled module.

const discovery: ExternalModuleDiscovery = {
  id: "videos-draft",
  dir: "/modules/videos-draft",
  manifest: {
    id: "videos-draft",
    name: "Videos",
    version: "0.0.1",
    publisher: "test"
  } as ExternalModuleDiscovery["manifest"],
  manifestHash: "manifest-hash",
  packageHash: "package-hash"
};

function buildFakeDb(state: Record<string, unknown> | undefined) {
  const executeTakeFirst = vi.fn().mockResolvedValue(state);
  const db = {
    selectFrom: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirst
    }))
  };
  return db as never;
}

describe("createIsModuleEnabled (#1753)", () => {
  it("treats a draft as enabled regardless of its stored hashes", async () => {
    const db = buildFakeDb({ status: "draft", manifest_hash: "stale", package_hash: "stale" });
    const isModuleEnabled = createIsModuleEnabled({ db, getDiscoveryById: () => discovery });
    await expect(isModuleEnabled("videos-draft")).resolves.toBe(true);
  });

  it("keeps existing enabled-module behaviour: exact hash match required", async () => {
    const db = buildFakeDb({
      status: "enabled",
      manifest_hash: "manifest-hash",
      package_hash: "package-hash"
    });
    const isModuleEnabled = createIsModuleEnabled({ db, getDiscoveryById: () => discovery });
    await expect(isModuleEnabled("videos-draft")).resolves.toBe(true);
  });

  it("stays disabled for an enabled module whose package hash drifted", async () => {
    const db = buildFakeDb({
      status: "enabled",
      manifest_hash: "manifest-hash",
      package_hash: "different"
    });
    const isModuleEnabled = createIsModuleEnabled({ db, getDiscoveryById: () => discovery });
    await expect(isModuleEnabled("videos-draft")).resolves.toBe(false);
  });

  it("returns false for a module that isn't discovered on disk", async () => {
    const db = buildFakeDb(undefined);
    const isModuleEnabled = createIsModuleEnabled({ db, getDiscoveryById: () => undefined });
    await expect(isModuleEnabled("missing")).resolves.toBe(false);
  });
});
