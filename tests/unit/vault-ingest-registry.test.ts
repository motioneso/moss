import { beforeEach, describe, expect, it } from "vitest";

import {
  HARD_EXCLUDED_PREFIXES,
  isPathIngestable,
  listVaultIngestRootProviders,
  registerVaultIngestRootProvider,
  resetVaultIngestRootProvidersForTests,
  resolveIngestRoots
} from "../../packages/memory/src/vault-ingest-registry.js";

describe("vault-ingest-registry", () => {
  beforeEach(() => {
    resetVaultIngestRootProvidersForTests();
  });

  it("never treats an unregistered path as ingestable", () => {
    // A default-open predicate would let anything through when no roots resolve for the owner.
    expect(isPathIngestable("people-notes/alice.md", [])).toBe(false);
  });

  it("treats a path under a registered root as ingestable, and a path outside it as not", () => {
    expect(isPathIngestable("people-notes/alice.md", ["people-notes"])).toBe(true);
    expect(isPathIngestable("other/alice.md", ["people-notes"])).toBe(false);
  });

  for (const prefix of HARD_EXCLUDED_PREFIXES) {
    it(`never treats a path under hard-excluded prefix "${prefix}" as ingestable, even if a root would otherwise allow it`, () => {
      const bareRoot = prefix.replace(/\/$/, "");
      const path = `${prefix}thing.md`;
      // Hard guard must win even when the resolved roots list would otherwise match this path.
      expect(isPathIngestable(path, [bareRoot])).toBe(false);
    });

    it(`throws when a provider resolves a root under hard-excluded prefix "${prefix}" (belt-and-braces)`, async () => {
      const bareRoot = prefix.replace(/\/$/, "");
      const provider = { moduleId: "misconfigured", resolveRoots: async () => [bareRoot] };

      await expect(resolveIngestRoots(provider, {} as never, "owner-1")).rejects.toThrow(
        /hard-excluded/i
      );
    });
  }

  it("never treats a non-.md path under a valid root as ingestable", () => {
    expect(isPathIngestable("people-notes/attachment.png", ["people-notes"])).toBe(false);
    expect(isPathIngestable("people-notes/alice.MD", ["people-notes"])).toBe(false);
  });

  it("registers and lists providers in registration order", () => {
    const providerA = { moduleId: "people", resolveRoots: async () => ["people-notes"] };
    const providerB = { moduleId: "structured-state", resolveRoots: async () => [] };

    registerVaultIngestRootProvider(providerA);
    registerVaultIngestRootProvider(providerB);

    expect(listVaultIngestRootProviders()).toEqual([providerA, providerB]);
  });

  it("passes through a provider's resolved roots unchanged when none are hard-excluded", async () => {
    const provider = { moduleId: "people", resolveRoots: async () => ["people-notes", "journal"] };

    await expect(resolveIngestRoots(provider, {} as never, "owner-1")).resolves.toEqual([
      "people-notes",
      "journal"
    ]);
  });
});
