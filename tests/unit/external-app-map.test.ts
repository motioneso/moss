import { describe, expect, it, vi } from "vitest";

import {
  externalAppMapItems,
  reconcileExternalModules,
  validateExternalModuleManifest
} from "@moss/module-registry";
import { createAppMapReadService } from "@moss/settings";

const base = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" }
};

const appMap = {
  screens: [
    {
      id: "acme-widgets.home",
      label: "Widgets",
      description: "All widgets.",
      path: "/"
    },
    {
      id: "acme-widgets.archive",
      label: "Archive",
      description: "Retired widgets.",
      path: "/archive"
    }
  ],
  settings: [
    {
      id: "acme-widgets.keys",
      label: "Keys",
      description: "Admin keys.",
      path: "/settings",
      scope: "admin" as const
    }
  ],
  features: [{ id: "acme-widgets.sync", description: "Syncs widgets." }]
};

function validate(extra: unknown) {
  return validateExternalModuleManifest({ ...base, appMap: extra }, "acme-widgets", "0.1.0");
}

describe("external appMap block (#3168)", () => {
  it("validates at install and keeps the block on the manifest", () => {
    const result = validate(appMap);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.appMap).toEqual(appMap);
  });

  it.each([
    ["an id without the module prefix", { screens: [{ ...appMap.screens[0], id: "today" }] }],
    ["an absolute-looking path", { screens: [{ ...appMap.screens[0], path: "/../x" }] }],
    ["an unknown field", { screens: [{ ...appMap.screens[0], permissionId: "x" }] }],
    ["a bad setting scope", { settings: [{ ...appMap.settings[0], scope: "system" }] }],
    ["an unknown block", { errors: [] }]
  ])("rejects %s", (_name, bad) => {
    expect(validate(bad).ok).toBe(false);
  });

  it("puts every path under the module's own route", () => {
    const items = externalAppMapItems([{ id: "acme-widgets", appMap }]);
    expect(items.screens.map((s) => s.path)).toEqual([
      "/m/acme-widgets",
      "/m/acme-widgets/archive"
    ]);
    expect(items.settings[0]?.path).toBe("/m/acme-widgets/settings");
    expect(items.settings[0]?.scope).toBe("admin");
    expect(items.features[0]?.moduleId).toBe("acme-widgets");
  });

  it("survives reconcile", () => {
    const parsed = validate(appMap);
    if (!parsed.ok) throw new Error("fixture must validate");
    const { modules } = reconcileExternalModules(
      [
        {
          id: "acme-widgets",
          dir: "/x",
          manifest: parsed.manifest,
          manifestHash: "m",
          packageHash: "p"
        }
      ],
      [{ id: "acme-widgets", status: "enabled", packageHash: "p", disabledReason: null } as never]
    );
    expect(modules[0]?.appMap).toEqual(appMap);
  });

  // Today's read service only knows the built artifact, so an installed module never shows up.
  it("reaches the app-map query for a user with the module, and not for one without", async () => {
    const artifact = {
      schemaVersion: 1 as const,
      build: { version: "t", buildId: "t" },
      screens: [],
      settings: [],
      features: [],
      errors: [],
      remediations: [],
      narrative: { authoritative: false as const, markdown: "" }
    };
    const withModule = new Set(["user-with"]);
    const service = createAppMapReadService({
      artifact,
      resolveActiveModules: async (userId) =>
        withModule.has(userId) ? [{ id: "acme-widgets" }] : [],
      resolveExternalAppMap: async (userId) =>
        externalAppMapItems(withModule.has(userId) ? [{ id: "acme-widgets", appMap }] : []),
      resolveFeatureFlagState: vi.fn().mockReturnValue(true),
      getUser: vi.fn().mockResolvedValue({ is_instance_admin: false }),
      logGap: vi.fn()
    });

    const hit = await service.query({} as never, "user-with", { screenId: "acme-widgets.archive" });
    expect(hit.items.map((i) => i.path)).toEqual(["/m/acme-widgets/archive"]);

    const miss = await service.query({} as never, "user-without", {
      screenId: "acme-widgets.archive"
    });
    expect(miss.items).toEqual([]);

    const adminOnly = await service.query({} as never, "user-with", {
      settingId: "acme-widgets.keys"
    });
    expect(adminOnly.items).toEqual([]);
  });
});
