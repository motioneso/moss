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
      "jobs, connections and logs sections hold at most 16 KB each"
    );
    expect(feature("settings.platformDiagnostics.limits")?.description).not.toContain(
      "cannot yet show"
    );
    expect(feature("settings.platformDiagnostics.connections")?.description).toContain(
      "cannot tell an incomplete scan from an unreachable helper"
    );
  });

  it("declares the admin-only logs section, its owner rule and the gap error", () => {
    const logs = feature("settings.platformDiagnostics.logs");
    expect(logs?.description).toContain("instance admins only");
    expect(logs?.description).toContain(
      "Text shows for your own records and unowned platform records"
    );
    expect(feature("settings.platformDiagnostics.logs.retention")?.description).toContain(
      "about 50,000 records"
    );
    expect(feature("settings.platformDiagnostics.logs.privacy")?.description).toContain(
      "Unowned text may hold private data a pattern cannot recognise"
    );
    const error = logs?.errors?.find((entry) => entry.code === "log_store_empty_or_gap");
    expect(error?.class).toBe("prerequisite");
    expect(logs?.remediations?.some((entry) => entry.id === error?.remediationRef)).toBe(true);
  });

  it("declares the hidden-for-non-admins outcome with a remediation", () => {
    const parent = feature("settings.platformDiagnostics");
    const error = parent?.errors?.find((entry) => entry.code === "admin_only_section");
    expect(error?.class).toBe("prerequisite");
    const remediation = parent?.remediations?.find((entry) => entry.id === error?.remediationRef);
    expect(remediation?.path).toBe("/settings");
  });
});
