import { describe, expect, it } from "vitest";

import { createExternalToolManifests } from "../../packages/module-registry/src/external/tool-manifests.js";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";

const discovery: ExternalModuleDiscovery = {
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
        name: "demo.update",
        permissionId: "demo.update",
        description: "Update a demo record.",
        risk: "write",
        actionFamilyId: "demo_changes",
        executionPolicy: "auto",
        selfOperationGrant: "granted_at_install",
        confirmWhen: [{ key: "status", equals: "active" }],
        confirmWhenKeys: ["vaultEnabled"],
        inputSchema: { type: "object" },
        handler: "demo.update"
      }
    ]
  },
  manifestHash: "sha256:demo",
  packageHash: "sha256:demo"
};

const invoke = async () => ({ data: {} });

describe("external tool manifest policy mapping (#1246)", () => {
  it("passes the action family and install grant into the live manifest", () => {
    const [manifest] = createExternalToolManifests([discovery], invoke);

    expect(manifest?.assistantActionFamilies).toEqual(discovery.manifest.assistantActionFamilies);
    expect(manifest?.assistantTools?.[0]).toMatchObject({
      actionFamilyId: "demo_changes",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install"
    });
  });

  it("confirms only the declared exceptional value", async () => {
    const [manifest] = createExternalToolManifests([discovery], invoke);
    const requiresConfirmation = manifest?.assistantTools?.[0]?.requiresConfirmation;

    expect(await requiresConfirmation?.({} as never, { status: "active" }, {} as never)).toBe(true);
    expect(await requiresConfirmation?.({} as never, { status: "building" }, {} as never)).toBe(
      false
    );
  });

  it("confirms when a declared exceptional key is present, including false", async () => {
    const [manifest] = createExternalToolManifests([discovery], invoke);
    const requiresConfirmation = manifest?.assistantTools?.[0]?.requiresConfirmation;

    expect(await requiresConfirmation?.({} as never, { vaultEnabled: false }, {} as never)).toBe(
      true
    );
    expect(await requiresConfirmation?.({} as never, { titles: ["Engineer"] }, {} as never)).toBe(
      false
    );
  });

  // #2152: `safeErrors` lets a tool echo its own thrown HttpError text to the user and the model
  // (#1679/#2148), and the gateway repeats that text verbatim, so choosing it is a first-party
  // trust decision — an installed module's declaration must never be able to select it. Module
  // manifests are JSON, not type-checked, so the cast below plants a flag a real module could
  // ship. If the copy is ever swapped for a copy-everything spread, this fails.
  it("never forwards the first-party-only safeErrors flag from an installed module", () => {
    const hostile = {
      ...discovery,
      manifest: {
        ...discovery.manifest,
        assistantTools: [
          {
            ...discovery.manifest.assistantTools?.[0],
            safeErrors: true
          } as unknown as NonNullable<ExternalModuleDiscovery["manifest"]["assistantTools"]>[number]
        ]
      }
    } as ExternalModuleDiscovery;

    const [manifest] = createExternalToolManifests([hostile], invoke);
    const tool = manifest?.assistantTools?.[0];
    expect(tool).toBeDefined();
    expect(tool && "safeErrors" in tool).toBe(false);
    expect(tool?.safeErrors).toBeUndefined();
  });
});
