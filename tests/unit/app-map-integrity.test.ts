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
      // The workshop screen is contributed at runtime via MODULE_WEB_ROUTES in the
      // virtual:moss-module-web bundle, so the static route metadata this test can
      // import never lists it. Accept it explicitly instead of failing a real screen.
      "/workshop"
    ]);

    for (const screen of appMap.screens) {
      expect(
        validPaths.has(screen.path) || screen.path.startsWith("/m/"),
        `Screen "${screen.id}" has invalid path "${screen.path}"`
      ).toBe(true);
    }
  });

  it("every app map remediation points at a truthful route", () => {
    const validPaths = new Set([
      ...webRoutes.map((r) => r.path),
      // Same runtime-contributed workshop route as above: invisible to this test's
      // static import but reachable in the app, so an error link there stays valid.
      "/workshop"
    ]);
    const validSectionPattern = /^\/settings\?section=([a-z0-9_-]+)(&module=([a-z0-9_-]+))?$/;

    expect(appMap.remediations.length).toBeGreaterThan(0);
    for (const remediation of appMap.remediations) {
      const path = remediation.path ?? "";
      const isWorkshopPath = path === "/workshop" || path.startsWith("/workshop/");
      const isScreenPath = validPaths.has(path) || path.startsWith("/m/") || isWorkshopPath;
      const isSettingsPath = validSectionPattern.test(path);
      expect(
        isScreenPath || isSettingsPath,
        `Remediation "${remediation.id}" has invalid path "${remediation.path}"`
      ).toBe(true);
    }
  });

  it("every app map setting resolves to a canonical settings section", () => {
    const validSectionPattern = /^\/settings\?section=([a-z0-9_-]+)(&module=([a-z0-9_-]+))?$/;
    const coreSectionIds = new Set(CORE_APP_SETTINGS.map((s) => s.id));
    const moduleIds = new Set(getBuiltInModuleManifests().map((m) => m.id));

    for (const setting of appMap.settings) {
      const match = validSectionPattern.exec(setting.path ?? "");
      expect(
        match !== null,
        `Setting "${setting.id}" has non-canonical path "${setting.path}"`
      ).toBe(true);
      if (!match) continue;
      // A stale section or module name must fail: the section has to exist on the
      // real Settings page and the module has to be a real built-in module.
      expect(
        coreSectionIds.has(match[1]!),
        `Setting "${setting.id}" points at unknown settings section "${match[1]}"`
      ).toBe(true);
      if (match[2]) {
        expect(match[1], `Setting "${setting.id}" names a module but misses section=modules`).toBe(
          "modules"
        );
        expect(
          moduleIds.has(match[3]!),
          `Setting "${setting.id}" points at unknown module "${match[3]}"`
        ).toBe(true);
      }
    }
  });

  it("contains no duplicate screen IDs or duplicate setting IDs", () => {
    // Bare IDs: the map is one shared namespace for Moss, so the same id declared
    // twice reads as two different things even when the owners differ.
    const screenIds = new Set<string>();
    for (const screen of appMap.screens) {
      expect(screenIds.has(screen.id!), `Duplicate screen id "${screen.id}"`).toBe(false);
      screenIds.add(screen.id!);
    }

    const settingIds = new Set<string>();
    for (const setting of appMap.settings) {
      expect(settingIds.has(setting.id!), `Duplicate setting id "${setting.id}"`).toBe(false);
      settingIds.add(setting.id!);
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
