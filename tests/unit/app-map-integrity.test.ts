import { describe, expect, it } from "vitest";

import { webRoutes } from "../../apps/web/src/app-route-metadata.js";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { CORE_APP_SCREENS, CORE_APP_SETTINGS } from "@moss/shared";
import { buildAppMap } from "../../scripts/build-app-map.js";

describe("app-map integrity and truthfulness", () => {
  const appMap = buildAppMap({
    manifests: getBuiltInModuleManifests(),
    coreScreens: CORE_APP_SCREENS,
    coreSettings: CORE_APP_SETTINGS,
    version: "test",
    buildId: "test",
    narrative: ""
  });

  it("every app map screen has a truthful route in webRoutes", () => {
    const validPaths = new Set([
      ...webRoutes.map((r) => r.path),
      "/workshop" // contributed via MODULE_WEB_ROUTES in virtual:moss-module-web
    ]);

    for (const screen of appMap.screens) {
      expect(
        validPaths.has(screen.path) || screen.path.startsWith("/m/"),
        `Screen "${screen.id}" has invalid path "${screen.path}"`
      ).toBe(true);
    }
  });

  it("every app map setting resolves to a canonical settings section", () => {
    const validSectionPattern = /^\/settings\?section=([a-z0-9_-]+)(&module=([a-z0-9_-]+))?$/;

    for (const setting of appMap.settings) {
      expect(
        validSectionPattern.test(setting.path),
        `Setting "${setting.id}" has non-canonical path "${setting.path}"`
      ).toBe(true);
    }
  });

  it("contains no duplicate screen IDs or duplicate setting IDs", () => {
    const screenIds = new Set<string>();
    for (const screen of appMap.screens) {
      const key = `${screen.moduleId}:${screen.id}`;
      expect(screenIds.has(key), `Duplicate screen key "${key}"`).toBe(false);
      screenIds.add(key);
    }

    const settingIds = new Set<string>();
    for (const setting of appMap.settings) {
      const key = `${setting.moduleId}:${setting.id}`;
      expect(settingIds.has(key), `Duplicate setting key "${key}"`).toBe(false);
      settingIds.add(key);
    }
  });

  it("every prerequisite error has a declared remediation", () => {
    const remediationIds = new Set(appMap.remediations.map((r) => r.id));

    for (const error of appMap.errors) {
      if (error.class === "prerequisite") {
        expect(
          error.remediationRef,
          `Prerequisite error "${error.code}" must specify remediationRef`
        ).toBeDefined();
        expect(
          remediationIds.has(error.remediationRef!),
          `Prerequisite error "${error.code}" references undeclared remediation "${error.remediationRef}"`
        ).toBe(true);
      }
    }
  });

  it("every app map description is non-empty and module descriptions meet the 240-char limit", () => {
    const allSurfaces = [
      ...appMap.screens.map((s) => ({
        moduleId: s.moduleId,
        kind: "screen",
        id: s.id,
        desc: s.description
      })),
      ...appMap.settings.map((s) => ({
        moduleId: s.moduleId,
        kind: "setting",
        id: s.id,
        desc: s.description
      })),
      ...appMap.features.map((f) => ({
        moduleId: f.moduleId,
        kind: "feature",
        id: f.id,
        desc: f.description
      })),
      ...appMap.errors.map((e) => ({
        moduleId: e.moduleId,
        kind: "error",
        id: e.code,
        desc: e.description
      })),
      ...appMap.remediations.map((r) => ({
        moduleId: r.moduleId,
        kind: "remediation",
        id: r.id,
        desc: r.description
      }))
    ];

    for (const item of allSurfaces) {
      const trimmed = item.desc.trim();
      expect(trimmed.length > 0, `${item.kind} "${item.id}" description must not be empty`).toBe(
        true
      );
      if (item.moduleId !== "core") {
        expect(
          trimmed.length <= 240,
          `Module "${item.moduleId}" ${item.kind} "${item.id}" description length (${trimmed.length}) must be <= 240 characters`
        ).toBe(true);
      }
    }
  });
});
