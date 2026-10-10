import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getBuiltInModuleManifests } from "@moss/module-registry";
import { CORE_APP_SCREENS, CORE_APP_SETTINGS } from "@moss/shared";
import { buildAppMap } from "../../scripts/build-app-map.js";

// Behavior lives in each surface's focused DOM tests. These assertions cover the
// same-PR declarations consumed by the assistant, including unchanged destinations.
const map = buildAppMap({
  manifests: getBuiltInModuleManifests(),
  coreScreens: CORE_APP_SCREENS,
  coreSettings: CORE_APP_SETTINGS,
  version: "test",
  buildId: "park-press",
  narrative: ""
});

describe("Park Press integrated recovery declarations", () => {
  it.each([
    ["tasks.module-settings", "tasks"],
    ["calendar.module-settings", "calendar"],
    ["wellness.ai-consent", "wellness"],
    ["email.module-settings", "email"]
  ])("%s describes unavailable reads and retry without changing its route", (id, moduleId) => {
    const setting = map.settings.find((item) => item.id === id);
    expect(setting?.path).toBe(`/settings?section=modules&module=${moduleId}`);
    expect(setting?.description).toMatch(/unknown/i);
    expect(setting?.description).toMatch(/retry/i);
    expect(setting?.description).toMatch(/confirmed/i);
  });

  it.each(["priorities", "people", "oversight", "audit", "memory"])(
    "core %s explains recovery at its existing destination",
    (id) => {
      const setting = map.settings.find((item) => item.id === id);
      expect(setting?.path).toBe(`/settings?section=${id}`);
      expect(setting?.description).toMatch(/retry|try again/i);
    }
  );

  it("describes retained Calendar views and accessible narrow scrolling", () => {
    const calendar = map.screens.find((item) => item.id === "calendar");
    expect(calendar?.path).toBe("/calendar");
    for (const phrase of ["Day", "Week", "Month", "scroll horizontally", "retains loaded"]) {
      expect(calendar?.description).toContain(phrase);
    }
  });

  it("keeps notification read and write recovery distinct", () => {
    const notifications = map.screens.find((item) => item.id === "notifications");
    expect(notifications?.description).toContain("no unread notifications");
    expect(notifications?.description).toContain("unknown counts");
    expect(notifications?.description).toContain("beside that item");
    expect(notifications?.description).toContain("Mark all read");
  });

  it("makes companion retry a read rather than another approval", () => {
    const companion = map.screens.find((item) => item.id === "link-trail-marker");
    expect(companion?.path).toBe("/link/trail-marker");
    expect(companion?.description).toContain("without approving it");
    expect(companion?.description).toContain("new link");
  });

  it("keeps Finance on the merged release and describes confirmed settings", () => {
    const finance = JSON.parse(
      readFileSync(
        new URL("../../external-modules/finance/jarvis.module.json", import.meta.url),
        "utf8"
      )
    ) as {
      version: string;
      settingsPath: string;
      appMap: { features: { id: string; description: string }[] };
    };
    expect(finance.version).toBe("0.6.8");
    expect(finance.settingsPath).toBe("/settings");
    for (const id of ["finance.settings-freedom", "finance.settings-limit"]) {
      const feature = finance.appMap.features.find((item) => item.id === id);
      expect(feature?.description).toContain("Until policy and limit reads succeed");
      expect(feature?.description).toContain("without writing");
    }
  });
});
