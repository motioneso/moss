import { describe, expect, it } from "vitest";

import { STRUCTURED_ACTIVITY_TITLES } from "../../apps/web/src/settings/settings-activity-line.js";
import { aiModuleManifest } from "../../packages/ai/src/manifest.js";
import { briefingsModuleManifest } from "../../packages/briefings/src/manifest.js";
import { commitmentsModuleManifest } from "../../packages/commitments/src/manifest.js";
import { connectorsModuleManifest } from "../../packages/connectors/src/manifest.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { webModuleManifest } from "../../packages/web-research/src/manifest.js";
import { workshopModuleManifest } from "../../packages/workshop/src/manifest.js";

/**
 * #2956 (slice D): every structured-call line title the Activity page renders comes from
 * the calling module's manifest `features` metadata (spec section 9), so the line title
 * and the app map agree. Each entry's feature id is the action code; its description is
 * the exact title.
 */
const MANIFESTS = [
  aiModuleManifest,
  briefingsModuleManifest,
  commitmentsModuleManifest,
  connectorsModuleManifest,
  newsModuleManifest,
  sportsModuleManifest,
  webModuleManifest,
  workshopModuleManifest
] as const;

function declaredTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const manifest of MANIFESTS) {
    for (const feature of manifest.features ?? []) {
      if (feature.id.startsWith("structured.")) titles.set(feature.id, feature.description);
    }
  }
  return titles;
}

describe("structured activity titles agree with owning module manifests (#2956 slice D)", () => {
  it("declares every rendered structured title in its owning module manifest", () => {
    const declared = declaredTitles();
    for (const [code, title] of Object.entries(STRUCTURED_ACTIVITY_TITLES)) {
      expect(declared.get(code), `${code} must be declared in its module manifest`).toBe(title);
    }
  });

  it("renders every manifest-declared structured title", () => {
    const declared = declaredTitles();
    expect(declared.size).toBeGreaterThan(0);
    for (const [code, title] of declared) {
      expect(STRUCTURED_ACTIVITY_TITLES[code], `${code} must be rendered`).toBe(title);
    }
  });
});
