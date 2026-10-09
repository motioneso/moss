import { describe, expect, it } from "vitest";

import type {
  ModuleAssistantActionFamilyManifest,
  ModuleAssistantToolManifest
} from "@moss/module-sdk";

import { familyAllowsAutoRun, type ActionPolicyLookup } from "./policy.js";

const families: Record<string, ModuleAssistantActionFamilyManifest> = {
  sorting: {
    id: "sorting",
    label: "Sorting",
    description: "Sorting",
    defaultTier: "ask_each_time",
    allowedTiers: ["always_confirm", "trusted_auto"]
  },
  connect: {
    id: "connect",
    label: "Connect",
    description: "Connect",
    defaultTier: "always_confirm",
    allowedTiers: ["always_confirm"]
  }
};

const lookup: ActionPolicyLookup = {
  getFamilyTier: async () => null,
  getFamilyManifest: async (_m, f) => families[f] ?? null
};

const tool = (over: Partial<ModuleAssistantToolManifest>): ModuleAssistantToolManifest =>
  ({
    name: "finance.x",
    description: "x",
    permissionId: "finance.write",
    risk: "write",
    isExternal: true,
    executionPolicy: "auto",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ data: {} }),
    ...over
  }) as ModuleAssistantToolManifest;

describe("familyAllowsAutoRun with installed-module tools", () => {
  it("asks for a tool whose family allows only always_confirm", async () => {
    expect(await familyAllowsAutoRun(tool({ actionFamilyId: "connect" }), "finance", lookup)).toBe(
      false
    );
  });

  it("still runs a tool whose family allows trusted_auto", async () => {
    expect(await familyAllowsAutoRun(tool({ actionFamilyId: "sorting" }), "finance", lookup)).toBe(
      true
    );
  });

  it("still runs an installed-module tool that names no family", async () => {
    expect(await familyAllowsAutoRun(tool({}), "finance", lookup)).toBe(true);
  });

  it("asks when the tool names a family the lookup cannot find", async () => {
    expect(await familyAllowsAutoRun(tool({ actionFamilyId: "gone" }), "finance", lookup)).toBe(
      false
    );
  });
});
