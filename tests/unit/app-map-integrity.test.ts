import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { webRoutes } from "../../apps/web/src/app-route-metadata.js";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import {
  CORE_APP_ERRORS,
  CORE_APP_REMEDIATIONS,
  CORE_APP_SCREENS,
  CORE_APP_SETTINGS,
  RUST_APP_SCREENS
} from "@moss/shared";
import { buildAppMap } from "../../scripts/build-app-map.js";

describe("app-map integrity and truthfulness", () => {
  const rustRoutes = new Set(
    [
      ...readFileSync(
        new URL("../../rust-spike/network/src/web.rs", import.meta.url),
        "utf8"
      ).matchAll(/\.route\(\s*"([^" ]+)"/g)
    ]
      .map((match) => match[1])
      .concat(
        // The desktop app serves its own screens from moss-app:// links declared in its source.
        [
          ...readFileSync(
            new URL("../../rust-spike/shell/connect/src/main.rs", import.meta.url),
            "utf8"
          ).matchAll(/"(moss-app:\/\/[^"]+)"/g)
        ].map((match) => match[1])
      )
  );
  const rustErrorCodes = new Set(
    ["../../rust-spike/network/src/web.rs", "../../rust-spike/shell/connect/src/reach.rs"].flatMap(
      (file) =>
        [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"([a-z_]+)"/g)].map(
          (match) => match[1]
        )
    )
  );
  const appMap = buildAppMap({
    manifests: getBuiltInModuleManifests(),
    coreScreens: CORE_APP_SCREENS,
    coreSettings: CORE_APP_SETTINGS,
    version: "test",
    buildId: "test",
    narrative: ""
  });

  it("builds a separate Rust map with only real Rust routes", () => {
    const rustMap = buildAppMap({
      runtime: "rust",
      manifests: [],
      coreScreens: [...CORE_APP_SCREENS, ...RUST_APP_SCREENS],
      coreSettings: CORE_APP_SETTINGS,
      coreErrors: CORE_APP_ERRORS,
      coreRemediations: CORE_APP_REMEDIATIONS,
      version: "test",
      buildId: "test",
      narrative: ""
    });
    expect(rustMap.screens.map((entry) => entry.id)).toEqual([
      "rust-sign-in",
      "rust-desktop-connect"
    ]);
    expect(rustMap.settings.map((entry) => entry.id)).toEqual(["rust-network-sharing"]);
    for (const entry of [...rustMap.screens, ...rustMap.settings, ...rustMap.remediations]) {
      expect(rustRoutes.has(entry.path ?? "")).toBe(true);
    }
    expect(rustMap.errors.some((entry) => entry.code === "host_refused")).toBe(true);
    for (const entry of rustMap.errors) {
      expect(
        rustErrorCodes.has(entry.code ?? ""),
        `Rust error "${entry.code}" is not in Rust`
      ).toBe(true);
    }
  });

  it("keeps Rust-only declarations out of the production TypeScript app map", () => {
    const production = buildAppMap({
      manifests: [],
      coreScreens: [...CORE_APP_SCREENS, ...RUST_APP_SCREENS],
      coreSettings: CORE_APP_SETTINGS,
      coreErrors: CORE_APP_ERRORS,
      coreRemediations: CORE_APP_REMEDIATIONS,
      version: "test",
      buildId: "test",
      narrative: ""
    });
    for (const entries of [
      production.screens,
      production.settings,
      production.errors,
      production.remediations
    ]) {
      expect(entries.some((entry) => "runtime" in entry && entry.runtime === "rust")).toBe(false);
    }
    expect(production.errors.some((entry) => entry.code === "host_refused")).toBe(false);
    expect(production.screens.some((entry) => entry.path === "/today")).toBe(true);
  });

  it("distinguishes corrective input failures from unavailable approval details", () => {
    const feature = getBuiltInModuleManifests()
      .find((module) => module.id === "chat")
      ?.features?.find((entry) => entry.id === "chat.pending_action_disclosure");
    expect(feature?.errors).toContainEqual(
      expect.objectContaining({
        code: "invalid_input",
        class: "validation"
      })
    );
    expect(feature?.errors).toContainEqual(
      expect.objectContaining({ code: "approval_unavailable", class: "prerequisite" })
    );
    expect(feature?.errors?.find((entry) => entry.code === "invalid_input")?.description).toContain(
      "Correct the fields"
    );
  });

  it("distinguishes linked setup fixes from unexpected preparation failures", () => {
    const feature = getBuiltInModuleManifests()
      .find((module) => module.id === "chat")
      ?.features?.find((entry) => entry.id === "chat.pending_action_disclosure");
    const setup = feature?.errors?.find((entry) => entry.code === "approval_setup_required");
    expect(setup).toMatchObject({
      class: "prerequisite",
      remediationRef: "chat.configure_action_source"
    });
    expect(
      feature?.remediations?.find((entry) => entry.id === setup?.remediationRef)
    ).toMatchObject({ path: "/settings?section=sources" });
    const unexpected = feature?.errors?.find(
      (entry) => entry.code === "approval_preparation_failed"
    );
    expect(unexpected).toMatchObject({ class: "transient" });
    expect(unexpected?.description).toContain("Try again");
    expect(unexpected?.remediationRef).toBeUndefined();
    expect(unexpected?.description).not.toContain("Settings");
    const fresh = feature?.remediations?.find((entry) => entry.id === "chat.request_fresh_action");
    expect(fresh?.description).toContain("ask Moss to find the action again");
    expect(fresh?.description).not.toContain("app screen");
    const notes = getBuiltInModuleManifests()
      .find((module) => module.id === "notes")
      ?.features?.find((entry) => entry.id === "notes.approval_prerequisites");
    expect(notes?.errors).toContainEqual(
      expect.objectContaining({ class: "prerequisite", remediationRef: "notes.configure_folder" })
    );
    expect(notes?.remediations).toContainEqual(
      expect.objectContaining({ id: "notes.configure_folder", path: "/settings?section=sources" })
    );
  });

  it("makes the deletion exception visible beside the note trust setting", () => {
    const notes = getBuiltInModuleManifests().find((module) => module.id === "notes");
    expect(
      notes?.assistantActionFamilies?.find((family) => family.id === "note_changes")?.description
    ).toContain("Deleting a note always asks for approval.");
  });

  it("describes exact server disclosure, raw permission exceptions and quiet outcomes", () => {
    // The Your assistant page is split across several topic entries sharing one path.
    const provider = {
      description: CORE_APP_SETTINGS.filter(
        (screen) => screen.path === "/settings?section=assistant"
      )
        .map((screen) => screen.description)
        .join(" ")
    };
    for (const text of [
      "server-owned action title",
      "full resolved target",
      "exact requested changes as readable label and value rows",
      "deleting a saved memory or a note uses red",
      "permanent with no trash or undo",
      "clear keyboard focus outline",
      "exact path or command",
      "complete validated arguments without truncation",
      "Approve is unavailable and Reject remains available",
      "without a selected-box outline"
    ])
      expect(provider?.description).toContain(text);
    expect(provider?.description).not.toContain("a reloaded pending card keeps its saved summary");
    const outcome = CORE_APP_ERRORS.find((error) => error.code === "core.ai.action_not_approved");
    for (const text of ["You declined", "Timed out", "Cancelled"]) {
      expect(outcome?.description).toContain(`"${text}"`);
    }
    expect(outcome?.description).toContain("separate from the visible message");
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
      if ("runtime" in screen && screen.runtime === "rust") {
        expect(rustRoutes.has(screen.path), `Rust screen "${screen.id}" has no Rust route`).toBe(
          true
        );
        continue;
      }
      expect(
        validPaths.has(screen.path) || screen.path.startsWith("/m/"),
        `Screen "${screen.id}" has invalid path "${screen.path}"`
      ).toBe(true);
    }
  });

  it("Rust core remediations point at declared Rust routes", () => {
    const rustRemediations = CORE_APP_REMEDIATIONS.filter((entry) => entry.runtime === "rust");
    expect(rustRemediations.length).toBeGreaterThan(0);
    for (const entry of rustRemediations) expect(rustRoutes.has(entry.path ?? "")).toBe(true);
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

  it("every app map setting resolves to a canonical web section or declared Android activity", () => {
    const validSectionPattern = /^\/settings\?section=([a-z0-9_-]+)(&module=([a-z0-9_-]+))?$/;
    const coreSectionIds = new Set(CORE_APP_SETTINGS.map((s) => s.id));
    const moduleIds = new Set(getBuiltInModuleManifests().map((m) => m.id));
    const androidManifest = readFileSync(
      new URL("../../apps/vocci-delivery/AndroidManifest.xml", import.meta.url),
      "utf8"
    );
    const androidPackage = /<manifest\b[^>]*\bpackage="([^"]+)"/.exec(androidManifest)?.[1];
    const androidActivities = new Set(
      [...androidManifest.matchAll(/<activity\b[^>]*\bandroid:name="([^"]+)"/g)].map(
        (match) => match[1]
      )
    );

    for (const setting of appMap.settings) {
      if ("runtime" in setting && setting.runtime === "rust") {
        expect(
          rustRoutes.has(setting.path ?? ""),
          `Rust setting "${setting.id}" has no Rust route`
        ).toBe(true);
        continue;
      }
      if (setting.path?.startsWith("android:")) {
        const native = /^android:([^/]+)\/(\.[A-Za-z][A-Za-z0-9]*)$/.exec(setting.path);
        expect(native?.[1], `Setting "${setting.id}" has an unknown Android package`).toBe(
          androidPackage
        );
        expect(
          androidActivities.has(native?.[2] ?? ""),
          `Setting "${setting.id}" points at an undeclared Android activity`
        ).toBe(true);
        continue;
      }
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

  it("declares a map screen for every web route", () => {
    const mapPaths = new Set(appMap.screens.map((screen) => screen.path));
    for (const route of webRoutes) {
      expect(
        mapPaths.has(route.path),
        `Web route "${route.id}" (${route.path}) has no screen entry in the app map`
      ).toBe(true);
    }
  });

  it("declares a map setting for every section on the Settings page", () => {
    const pageSource = readFileSync(
      new URL("../../apps/web/src/settings/settings-page.tsx", import.meta.url),
      "utf8"
    );
    const sectionIds = [...pageSource.matchAll(/coreSettingDescription\("([a-z0-9_-]+)"\)/g)].map(
      (match) => match[1]!
    );
    expect(sectionIds.length).toBeGreaterThan(10);
    const mapped = new Set(
      CORE_APP_SETTINGS.map((setting) => /section=([a-z0-9_-]+)/.exec(setting.path)?.[1])
    );
    for (const id of sectionIds) {
      expect(mapped.has(id), `Settings section "${id}" has no app map entry`).toBe(true);
    }
    // The reverse: a map entry must not point at a section the page does not render.
    const rendered = new Set(sectionIds);
    for (const setting of CORE_APP_SETTINGS) {
      const section = /section=([a-z0-9_-]+)/.exec(setting.path)?.[1];
      if (!section) continue;
      expect(rendered.has(section), `Setting "${setting.id}" names unknown section`).toBe(true);
    }
  });

  it("keeps each core description short enough to summarise", () => {
    // Long topics are split into several entries that share a path rather than one wall of text.
    for (const surface of [...CORE_APP_SCREENS, ...RUST_APP_SCREENS, ...CORE_APP_SETTINGS]) {
      expect(
        surface.description.length,
        `Core entry "${surface.id}" is too long; split it into topic entries`
      ).toBeLessThanOrEqual(5000);
    }
  });

  it("describes where users reach modules that have no screen of their own", () => {
    const featureIds = new Set(appMap.features.map((feature) => feature.id));
    for (const id of [
      "notes.where-to-find",
      "goals.where-to-find",
      "commitments.where-to-find",
      "scratchpad.where-to-find",
      "proactive-monitoring.where-to-find",
      "workflows.where-to-find",
      "people.where-to-find",
      "usefulness-feedback.where-to-find",
      "connectors.imap_connect"
    ]) {
      expect(featureIds.has(id), `App map is missing "${id}"`).toBe(true);
    }
    const screenIds = new Set(appMap.screens.map((screen) => screen.id));
    expect(screenIds.has("chat-drawer")).toBe(true);
  });

  it("contains no duplicate screen IDs or duplicate setting IDs", () => {
    // Bare IDs: the map is one shared namespace for Moss, so the same id declared
    // twice reads as two different things even when the owners differ.
    const screenIds = new Set<string>();
    for (const screen of appMap.screens) {
      if ("runtime" in screen && screen.runtime === "rust") {
        expect(rustRoutes.has(screen.path), `Rust screen "${screen.id}" has no Rust route`).toBe(
          true
        );
        continue;
      }
      expect(screenIds.has(screen.id!), `Duplicate screen id "${screen.id}"`).toBe(false);
      screenIds.add(screen.id!);
    }

    const settingIds = new Set<string>();
    for (const setting of appMap.settings) {
      if ("runtime" in setting && setting.runtime === "rust") {
        expect(
          rustRoutes.has(setting.path ?? ""),
          `Rust setting "${setting.id}" has no Rust route`
        ).toBe(true);
        continue;
      }
      expect(settingIds.has(setting.id!), `Duplicate setting id "${setting.id}"`).toBe(false);
      settingIds.add(setting.id!);
    }
  });

  it("declares clock reminders, their deadline and every refusal Moss gives (#3150)", () => {
    const feature = (id: string) => appMap.features.find((item) => item.id === id);
    expect(feature("chat.clock_reminders")?.description).toContain("today, tonight or tomorrow");
    expect(feature("chat.clock_reminders")?.description).toContain("Daily and weekly repeats");
    expect(feature("chat.repeating_reminders")?.description).toContain("60-86399-second");
    expect(feature("chat.reminder_deadline")?.description).toContain("never after the deadline");
    expect(feature("chat.reminder_deadline")?.description).toContain("marked late");
    expect(feature("chat.relative_reminders")?.description).not.toContain("No clock times");
    expect(feature("chat.reminder_list")?.description).toContain("skipped past its deadline");

    const codes = appMap.errors.map((error) => error.code);
    for (const code of [
      "reminder_needs_am_pm",
      "reminder_time_unclear",
      "reminder_day_unsupported",
      "reminder_time_passed",
      "reminder_time_changes_with_clocks",
      "reminder_time_zone_wrong",
      "reminder_deadline_invalid",
      "reminder_skipped_after_deadline"
    ]) {
      expect(codes).toContain(code);
    }
    const zone = appMap.remediations.find((item) => item.id === "chat.set_reminder_time_zone");
    expect(zone?.path).toBe("/settings?section=profile");
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

  it("finds the Your assistant settings page for plain model wordings", () => {
    // The map builder drops the AI module's shadow settings entry because core
    // already owns this path, so only the core wording ever reaches Moss. Search
    // the built map the way the map read service does: a case-insensitive
    // substring over the entry.
    const assistantEntries = appMap.settings.filter(
      (setting) => setting.path === "/settings?section=assistant"
    );
    expect(assistantEntries.length).toBeGreaterThan(0);
    for (const phrase of ["ai model", "which model", "change model"]) {
      const hits = assistantEntries.filter((entry) =>
        JSON.stringify(entry).toLowerCase().includes(phrase)
      );
      expect(hits.length, `expected "${phrase}" to find the Your assistant page`).toBeGreaterThan(
        0
      );
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
