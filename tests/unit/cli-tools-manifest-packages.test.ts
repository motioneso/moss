import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { loadPublisherPackages } from "../../scripts/cli-tools-manifest/packages.js";

describe("publisher package list mirrors the install catalog", () => {
  const listed = loadPublisherPackages();

  it("names every supported npm recipe, with the same per-arch packages", () => {
    for (const [provider, entry] of Object.entries(PROVIDER_CATALOG)) {
      const recipe = entry.recipe;
      if (entry.status !== "supported" || recipe?.kind !== "npm") continue;
      const row = listed.find((p) => p.pkg === recipe.pkg && p.role === "cli");
      expect(row, `${provider} ${recipe.pkg} is missing from packages.json`).toBeDefined();
      expect(row!.toolset).toBe(provider);
      expect([...row!.archPackages].sort()).toEqual(
        Object.values(recipe.archBinaryPackage ?? {}).sort()
      );
    }
  });

  it("gives every package an owner/repo provenance source", () => {
    for (const p of listed) expect(p.expectedRepo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});
