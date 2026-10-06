import { describe, expect, it } from "vitest";

import { SELF_OPERATION_EXCLUSIONS } from "@moss/ai";

import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  buildRouteCatalog,
  findUnmappedJulyPrefixes
} from "../../packages/module-registry/src/route-catalog.js";

/**
 * #3065 decision 2.22: every July exclusion prefix maps to a blocked route of the same category,
 * or is listed as having no route. Slice 3 classifies the platform-core modules; the prefixes
 * whose routes live in slice 4 modules stay pending until slice 4 classifies them.
 */

const SLICE_3_MODULES: ReadonlySet<string> = new Set([
  "settings",
  "ai",
  "chat",
  "connectors",
  "integrations",
  "notifications",
  "backtrack",
  "workflows",
  "proactive-monitoring",
  "usefulness-feedback"
]);

/** Prefixes whose routes are in slice 4 modules (tasks, news, briefings, notes, wellness, ...). */
const PENDING_SLICE_4: readonly string[] = [
  "settings.taskAgency.autoExecution.",
  "settings.credential.",
  "settings.wellnessAiConsent.",
  "settings.thirdPartySend.",
  "settings.scheduledWork.",
  "settings.notesSourceScheduling.",
  "settings.briefing.mutate.",
  "settings.briefing.run.",
  "settings.newsPreview.",
  "settings.newsRefresh."
];

describe("July rules route walk", () => {
  it("maps every prefix except the slice 4 pending list", () => {
    const manifests = getBuiltInModuleManifests().filter((m) => SLICE_3_MODULES.has(m.id));
    const catalog = buildRouteCatalog(manifests, []);
    const unmapped = findUnmappedJulyPrefixes(SELF_OPERATION_EXCLUSIONS, catalog);
    expect([...unmapped].sort()).toEqual([...PENDING_SLICE_4].sort());
  });
});
