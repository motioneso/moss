import { describe, expect, it } from "vitest";

import { SELF_OPERATION_EXCLUSIONS } from "@moss/ai";

import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  buildRouteCatalog,
  findUnmappedJulyPrefixes,
  CHAT_BLOCKED_PATH_RULES,
  JULY_EXCLUDED_ROUTES,
  JULY_PREFIXES_WITHOUT_ROUTES
} from "../../packages/module-registry/src/route-catalog.js";

/**
 * #3065 decision 2.22: every July exclusion prefix maps to a blocked route of the same category,
 * or is listed as having no route. Every built-in content and platform route is classified; no pending prefixes remain.
 */

describe("July rules route walk", () => {
  it("does not exempt a prefix already mapped for every required category", () => {
    for (const { prefix } of JULY_PREFIXES_WITHOUT_ROUTES) {
      const categories = SELF_OPERATION_EXCLUSIONS.filter((rule) =>
        rule.toolNamePrefixes.includes(prefix)
      ).map((rule) => rule.category);
      const mapped = [
        ...CHAT_BLOCKED_PATH_RULES.filter((rule) => rule.julyPrefixes?.includes(prefix)),
        ...JULY_EXCLUDED_ROUTES.filter((row) => row.julyPrefixes.includes(prefix))
      ].map((entry) => entry.category);
      // A prefix may occur in multiple categories (chatModelOverride does). Only its
      // unmapped category needs an exemption, never a fully mapped prefix.
      expect(
        categories.some((category) => !mapped.includes(category)),
        prefix
      ).toBe(true);
    }
  });
  it("maps every July prefix across every module", () => {
    const manifests = getBuiltInModuleManifests();
    const catalog = buildRouteCatalog(manifests, []);
    const unmapped = findUnmappedJulyPrefixes(SELF_OPERATION_EXCLUSIONS, catalog);
    expect([...unmapped].sort()).toEqual([]);
  });
});
