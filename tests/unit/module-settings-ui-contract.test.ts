import { describe, expect, it } from "vitest";
import type { ModuleSettingsSurfaceManifest } from "@moss/module-sdk";
import { formatTimestamp } from "@moss/settings-ui";

describe("settings UI package contract", () => {
  it("allows module manifests to declare a settings entry", () => {
    const surface: ModuleSettingsSurfaceManifest = {
      id: "fixture.settings",
      label: "Fixture",
      description: "Fixture settings surface for contract testing.",
      path: "/settings/modules/fixture",
      scope: "user",
      entry: "./settings"
    };

    expect(surface.entry).toBe("./settings");
  });

  it("exports existing settings atom helpers", () => {
    expect(
      formatTimestamp("not-a-date", "fallback", {
        timezone: "America/Los_Angeles",
        region: "en-US",
        dateFormat: "24"
      })
    ).toBe("fallback");
  });
});
