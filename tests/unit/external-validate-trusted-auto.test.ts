import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

const base = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" }
};

describe("trusted_auto family default (#3160)", () => {
  const toolBase = {
    name: "acme-widgets.update",
    label: "Update",
    description: "Update a widget",
    permissionId: "acme-widgets.update",
    risk: "write",
    handler: "update",
    executionPolicy: "auto",
    actionFamilyId: "fam"
  };
  const check = (family: Record<string, unknown>, tool: Record<string, unknown> = {}) =>
    validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantActionFamilies: [{ id: "fam", label: "Fam", description: "Fam", ...family }],
        assistantTools: [{ ...toolBase, ...tool }]
      },
      "acme-widgets",
      "0.1.0"
    );

  it("accepts a routine family that runs on its own by default", () => {
    expect(
      check({
        freedom: "routine",
        allowedTiers: ["ask_each_time", "trusted_auto"],
        defaultTier: "trusted_auto"
      }).ok
    ).toBe(true);
  });

  it("accepts a family that only ever runs on its own", () => {
    expect(check({ allowedTiers: ["trusted_auto"], defaultTier: "trusted_auto" }).ok).toBe(true);
  });

  it("rejects a new-thing family that runs on its own by default", () => {
    const result = check({
      freedom: "new",
      allowedTiers: ["ask_each_time", "trusted_auto"],
      defaultTier: "trusted_auto"
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an untagged family that the user can switch yet defaults to running", () => {
    expect(
      check({ allowedTiers: ["ask_each_time", "trusted_auto"], defaultTier: "trusted_auto" }).ok
    ).toBe(false);
  });

  it("rejects a trusted_auto default when a tool in the family is destructive or outbound", () => {
    for (const risk of ["destructive", "outbound"]) {
      const result = check(
        {
          freedom: "routine",
          allowedTiers: ["ask_each_time", "trusted_auto"],
          defaultTier: "trusted_auto"
        },
        { risk }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("trusted_auto");
    }
  });

  it("rejects a default that is not in allowedTiers", () => {
    expect(check({ allowedTiers: ["ask_each_time"], defaultTier: "trusted_auto" }).ok).toBe(false);
  });
});
