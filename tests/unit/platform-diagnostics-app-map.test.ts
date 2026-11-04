import { describe, expect, it } from "vitest";

import { settingsModuleManifest } from "@moss/settings";

function feature(id: string) {
  return settingsModuleManifest.features?.find((entry) => entry.id === id);
}

describe("app map entries for settings.platformDiagnostics (#3978)", () => {
  it("declares the admin-only jobs and connections sections", () => {
    expect(feature("settings.platformDiagnostics")?.description).toContain("instance admins only");
    expect(feature("settings.platformDiagnostics.jobs")?.description).toContain("last 24 hours");
    expect(feature("settings.platformDiagnostics.connections")?.description).toContain(
      "last good sync"
    );
  });

  it("states the limits, the log gap and the Outlook partial-state gap", () => {
    expect(feature("settings.platformDiagnostics.limits")?.description).toContain(
      "10 items and 16 KB"
    );
    expect(feature("settings.platformDiagnostics.limits")?.description).toContain(
      "cannot yet show application log lines"
    );
    expect(feature("settings.platformDiagnostics.connections")?.description).toContain(
      "cannot tell an incomplete scan from an unreachable helper"
    );
  });

  it("declares the hidden-for-non-admins outcome with a remediation", () => {
    const parent = feature("settings.platformDiagnostics");
    const error = parent?.errors?.find((entry) => entry.code === "admin_only_section");
    expect(error?.class).toBe("prerequisite");
    const remediation = parent?.remediations?.find((entry) => entry.id === error?.remediationRef);
    expect(remediation?.path).toBe("/settings");
  });
});
