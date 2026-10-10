import { describe, expect, it } from "vitest";

import { createExternalToolManifests } from "../../packages/module-registry/src/external/tool-manifests.js";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";

// P3 (#3183): a numeric confirmation rule that reads the module's own limit preference.

type Rule = NonNullable<
  NonNullable<ExternalModuleDiscovery["manifest"]["assistantTools"]>[number]["confirmAbove"]
>;

const invoke = async () => ({ data: {} });

const moneyModule = (confirmAbove: Rule): ExternalModuleDiscovery => ({
  id: "demo",
  dir: "/modules/demo",
  manifest: {
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    preferences: [{ key: "freedomLimitDollars", label: "Limit", type: "integer", default: null }],
    assistantActionFamilies: [
      {
        id: "demo_changes",
        label: "Demo changes",
        description: "Demo writes its own records.",
        defaultTier: "ask_each_time",
        allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
      }
    ],
    assistantTools: [
      {
        name: "demo.money",
        permissionId: "demo.money",
        description: "Move money.",
        risk: "write",
        actionFamilyId: "demo_changes",
        executionPolicy: "auto",
        selfOperationGrant: "granted_at_install",
        confirmAbove,
        inputSchema: { type: "object" },
        handler: "demo.money"
      }
    ]
  },
  manifestHash: "sha256:demo",
  packageHash: "sha256:demo"
});

const moveRule: Rule = {
  inputKey: "amountCents",
  preferenceKey: "freedomLimitDollars",
  scale: 100
};
const assignRule: Rule = { ...moveRule, baseKey: "previousCents" };
const limit100 = { "module:demo:freedomLimitDollars": 100 };

function check(
  rule: Rule,
  stored: Record<string, unknown> | Error,
  declaredDefault: number | null = null
) {
  const demo = moneyModule(rule);
  demo.manifest.preferences = [
    { key: "freedomLimitDollars", label: "Limit", type: "integer", default: declaredDefault }
  ];
  const [manifest] = createExternalToolManifests([demo], invoke, undefined, async () => {
    if (stored instanceof Error) throw stored;
    return stored;
  });
  const hook = manifest?.assistantTools?.[0]?.requiresConfirmation;
  return async (input: Record<string, unknown>) => hook?.({} as never, input, {} as never);
}

describe("confirmAbove numeric confirmation rule (#3183)", () => {
  it("asks for a move above the limit and runs one at the limit", async () => {
    const ask = check(moveRule, limit100);
    expect(await ask({ amountCents: 10001 })).toBe(true);
    expect(await ask({ amountCents: 10000 })).toBe(false);
  });

  it("measures an assign by its change from the previous amount, up or down", async () => {
    const ask = check(assignRule, limit100);
    expect(await ask({ amountCents: 5000, previousCents: 50000 })).toBe(true);
    expect(await ask({ amountCents: 55000, previousCents: 50000 })).toBe(false);
  });

  it("asks when the limit is missing or cleared", async () => {
    expect(await check(moveRule, {})({ amountCents: 1 })).toBe(true);
    expect(
      await check(moveRule, { "module:demo:freedomLimitDollars": null })({ amountCents: 1 })
    ).toBe(true);
  });

  it("uses the declared default only when nothing is stored, and asks on a garbled value", async () => {
    expect(await check(moveRule, {}, 100)({ amountCents: 10000 })).toBe(false);
    for (const garbled of ["50", 12.5, { v: 1 }, Number.NaN]) {
      expect(
        await check(
          moveRule,
          { "module:demo:freedomLimitDollars": garbled },
          100
        )({
          amountCents: 1
        })
      ).toBe(true);
    }
  });

  it("asks when the declared base is absent or the amount is not a number", async () => {
    const ask = check(assignRule, limit100);
    expect(await ask({ amountCents: 100 })).toBe(true);
    expect(await ask({ amountCents: "100", previousCents: 100 })).toBe(true);
  });

  it("asks when the preference cannot be read", async () => {
    expect(await check(moveRule, new Error("db down"))({ amountCents: 1 })).toBe(true);
  });
});
