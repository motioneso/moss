import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

const base = {
  schemaVersion: 1,
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  publisher: "Test",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" },
  runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 }
};

const family = {
  id: "demo_changes",
  label: "Demo changes",
  description: "Demo writes its own records.",
  defaultTier: "ask_each_time",
  allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
};

const grantedTool = {
  name: "demo.update",
  permissionId: "demo.update",
  description: "Update a demo record.",
  risk: "write",
  actionFamilyId: "demo_changes",
  executionPolicy: "auto",
  selfOperationGrant: "granted_at_install",
  inputSchema: { type: "object", additionalProperties: false },
  handler: "demo.update"
};

describe("external module action families (#1246)", () => {
  it("accepts and preserves an install-granted action family", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [family],
        assistantTools: [grantedTool]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.assistantActionFamilies).toEqual([family]);
    expect(result.manifest.assistantTools?.[0]).toMatchObject({
      actionFamilyId: "demo_changes",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install"
    });
  });

  it("rejects a tool naming a family the module did not declare", () => {
    const result = validateExternalModuleManifest(
      { ...base, assistantTools: [grantedTool] },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("demo_changes");
  });

  it("rejects an install grant whose family cannot be trusted or vetoed", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [
          { ...family, allowedTiers: ["ask_each_time"], defaultTier: "ask_each_time" }
        ],
        assistantTools: [grantedTool]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("trusted_auto");
      expect(result.errors.join(" ")).toContain("always_confirm");
    }
  });

  it("rejects a family default outside its allowed tiers", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [{ ...family, allowedTiers: ["trusted_auto", "always_confirm"] }]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("defaultTier");
  });

  it("accepts declarative exceptional-confirmation clauses", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [family],
        assistantTools: [
          {
            ...grantedTool,
            confirmWhen: [{ key: "status", equals: "active" }],
            confirmWhenKeys: ["vaultEnabled"]
          }
        ]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(true);
  });

  it("rejects malformed exceptional-confirmation clauses", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [family],
        assistantTools: [{ ...grantedTool, confirmWhen: [{ key: "status" }] }]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("confirmWhen");
  });

  it("accepts outbound risk with an always-confirm grant", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [family],
        assistantTools: [
          {
            ...grantedTool,
            risk: "outbound",
            executionPolicy: "confirm",
            selfOperationGrant: "confirm_always"
          }
        ]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.assistantTools?.[0]?.risk).toBe("outbound");
  });

  it("rejects an always-confirm tool that asks for auto execution", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantActionFamilies: [family],
        assistantTools: [{ ...grantedTool, selfOperationGrant: "confirm_always" }]
      },
      "demo",
      "0.1.0"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("confirm_always");
  });
});
