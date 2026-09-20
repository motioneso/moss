import { describe, it, expect } from "vitest";
import {
  familyAllowsAutoRun,
  resolvePolicy,
  type ActionPolicyLookup
} from "../../packages/ai/src/gateway/policy.js";
import type {
  ModuleAssistantToolManifest,
  ModuleAssistantActionFamilyManifest,
  MossActionPermissionTier
} from "../../packages/module-sdk/src/index.js";

describe("gateway policy resolver", () => {
  const createMockLookup = (
    tier: MossActionPermissionTier | null,
    manifest: ModuleAssistantActionFamilyManifest | null
  ): ActionPolicyLookup => ({
    getFamilyTier: async () => tier,
    getFamilyManifest: async () => manifest
  });

  const baseManifest: ModuleAssistantActionFamilyManifest = {
    id: "mock_family",
    label: "Mock Family",
    description: "Mock Family Description",
    defaultTier: "ask_each_time",
    allowedTiers: ["ask_each_time", "always_confirm"]
  };

  it("family-less write:auto tool returns confirm", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.tool",
      description: "Mock tool",
      permissionId: "mock.perm",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    // No familyId set
    const decision = await resolvePolicy(tool, "mock_module", false, createMockLookup(null, null));
    expect(decision).toBe("confirm");
  });

  it("trusted_auto tier confirms if tool executionPolicy is not auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.tool",
      description: "Mock tool",
      permissionId: "mock.perm",
      actionFamilyId: "mock_family",
      risk: "write",
      executionPolicy: "confirm", // Not auto
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const manifest: ModuleAssistantActionFamilyManifest = {
      ...baseManifest,
      allowedTiers: ["ask_each_time", "trusted_auto"]
    };

    const decision = await resolvePolicy(
      tool,
      "mock_module",
      false,
      createMockLookup("trusted_auto", manifest)
    );
    expect(decision).toBe("confirm");
  });

  it("trusted_auto tier confirms if manifest does not allow trusted_auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.tool",
      description: "Mock tool",
      permissionId: "mock.perm",
      actionFamilyId: "mock_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const manifest: ModuleAssistantActionFamilyManifest = {
      ...baseManifest,
      allowedTiers: ["ask_each_time", "always_confirm"] // Does not allow trusted_auto
    };

    const decision = await resolvePolicy(
      tool,
      "mock_module",
      false,
      createMockLookup("trusted_auto", manifest)
    );
    expect(decision).toBe("confirm");
  });

  it("trusted_auto tier runs if executionPolicy is auto and manifest allows trusted_auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.tool",
      description: "Mock tool",
      permissionId: "mock.perm",
      actionFamilyId: "mock_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const manifest: ModuleAssistantActionFamilyManifest = {
      ...baseManifest,
      allowedTiers: ["ask_each_time", "trusted_auto"]
    };

    const decision = await resolvePolicy(
      tool,
      "mock_module",
      false,
      createMockLookup("trusted_auto", manifest)
    );
    expect(decision).toBe("run");
  });

  it("confirmOverride forces confirm even under trusted_auto with executionPolicy auto", async () => {
    // The tool's own requiresConfirmation hook is no longer resolvePolicy's concern (it's
    // resolved by the gateway beforehand — see gateway.ts's computeConfirmOverride — precisely
    // so this function stays DB-free); resolvePolicy just takes the already-computed boolean.
    const tool: ModuleAssistantToolManifest = {
      name: "mock.tool",
      description: "Mock tool",
      permissionId: "mock.perm",
      actionFamilyId: "mock_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const manifest: ModuleAssistantActionFamilyManifest = {
      ...baseManifest,
      allowedTiers: ["ask_each_time", "trusted_auto"]
    };
    const lookup = createMockLookup("trusted_auto", manifest);

    // No override: still auto-runs under trusted_auto.
    await expect(resolvePolicy(tool, "mock_module", false, lookup)).resolves.toBe("run");

    // Override set: forced to confirm even though the family is trusted_auto and the tool's
    // own executionPolicy is "auto".
    await expect(resolvePolicy(tool, "mock_module", true, lookup)).resolves.toBe("confirm");
  });

  it("outbound confirms even under trusted_auto with executionPolicy auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.send",
      description: "Send something off-box",
      permissionId: "mock.send",
      actionFamilyId: "mock_family",
      risk: "outbound",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };
    const manifest: ModuleAssistantActionFamilyManifest = {
      ...baseManifest,
      allowedTiers: ["ask_each_time", "trusted_auto"]
    };

    await expect(
      resolvePolicy(tool, "mock_module", false, createMockLookup("trusted_auto", manifest))
    ).resolves.toBe("confirm");
  });
});

describe("familyAllowsAutoRun (#2418, #2419)", () => {
  const createMockLookup = (
    manifest: ModuleAssistantActionFamilyManifest | null
  ): ActionPolicyLookup => ({
    getFamilyTier: async () => null,
    getFamilyManifest: async () => manifest
  });

  const promotableManifest: ModuleAssistantActionFamilyManifest = {
    id: "promotable_family",
    label: "Promotable Family",
    description: "Allowed tiers includes trusted_auto",
    defaultTier: "ask_each_time",
    allowedTiers: ["ask_each_time", "trusted_auto"]
  };

  const nonPromotableManifest: ModuleAssistantActionFamilyManifest = {
    id: "strict_family",
    label: "Strict Family",
    description: "Allowed tiers does not include trusted_auto",
    defaultTier: "ask_each_time",
    allowedTiers: ["ask_each_time", "always_confirm"]
  };

  it("fails closed (returns false) when actionFamilyId is missing (#2419)", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.write",
      description: "Write tool without family",
      permissionId: "mock.write",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(promotableManifest)
    );
    expect(allowed).toBe(false);
  });

  it("fails closed (returns false) for destructive tools regardless of family (#2419)", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.destroy",
      description: "Destructive tool",
      permissionId: "mock.destroy",
      actionFamilyId: "promotable_family",
      risk: "destructive",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(promotableManifest)
    );
    expect(allowed).toBe(false);
  });

  it("fails closed (returns false) for outbound tools regardless of family", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.outbound",
      description: "Outbound tool",
      permissionId: "mock.outbound",
      actionFamilyId: "promotable_family",
      risk: "outbound",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(promotableManifest)
    );
    expect(allowed).toBe(false);
  });

  it("fails closed when tool executionPolicy is not auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.write",
      description: "Write tool",
      permissionId: "mock.write",
      actionFamilyId: "promotable_family",
      risk: "write",
      executionPolicy: "confirm",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(promotableManifest)
    );
    expect(allowed).toBe(false);
  });

  it("fails closed when family manifest cannot be found", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "mock.write",
      description: "Write tool",
      permissionId: "mock.write",
      actionFamilyId: "missing_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(tool, "mock_mod", createMockLookup(null));
    expect(allowed).toBe(false);
  });

  it("fails closed when family does not allow trusted_auto (e.g. workshop builds)", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "workshop.runCommand",
      description: "Build command",
      permissionId: "workshop.build",
      actionFamilyId: "strict_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(nonPromotableManifest)
    );
    expect(allowed).toBe(false);
  });

  it("allows auto run when tool is auto and family allows trusted_auto", async () => {
    const tool: ModuleAssistantToolManifest = {
      name: "calendar.create",
      description: "Create event",
      permissionId: "calendar.write",
      actionFamilyId: "promotable_family",
      risk: "write",
      executionPolicy: "auto",
      inputSchema: {},
      outputSchema: {},
      execute: async () => ({ data: {} })
    };

    const allowed = await familyAllowsAutoRun(
      tool,
      "mock_mod",
      createMockLookup(promotableManifest)
    );
    expect(allowed).toBe(true);
  });
});
