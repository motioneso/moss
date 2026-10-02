import { describe, expect, it, vi } from "vitest";

import {
  checkClassifierEligibility,
  type ExternalModuleClassifierDeclaration
} from "@moss/module-sdk";

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

// Plan 2.2 (#2882): the JSON classifier declaration becomes the SDK's function form. The
// candidate list is a handler name, so it is dropped without an invoker rather than faked.
const classifierTools = (
  classifier?: ExternalModuleClassifierDeclaration
): ExternalModuleDiscovery => ({
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
    assistantTools: [
      {
        name: "demo.switch",
        permissionId: "demo.switch",
        description: "Switch a demo device.",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: { device: { type: "string" } },
          required: ["device"]
        },
        outputSchema: { type: "object", properties: { name: { type: "string" } } },
        handler: "demo.switch",
        ...(classifier ? { classifier } : {})
      }
    ]
  },
  manifestHash: "sha256:demo",
  packageHash: "sha256:demo"
});

const candidatesClassifier: ExternalModuleClassifierDeclaration = {
  description: "Switch a demo device",
  arguments: { device: { kind: "candidates" } },
  candidatesHandler: "demo.devices",
  replyTemplate: "Switched {name}."
};

describe("external classifier synthesis (#2882)", () => {
  it("leaves a tool without an opt-in unchanged and ineligible", () => {
    const [manifest] = createExternalToolManifests([classifierTools()], invoke);
    const tool = manifest?.assistantTools?.[0] as { classifier?: unknown };
    expect(tool.classifier).toBeUndefined();
    expect(checkClassifierEligibility(tool as never)).toEqual({ eligible: false, problems: [] });
  });

  it("carries an enum-only classifier through the field-by-field remap", () => {
    const classifier: ExternalModuleClassifierDeclaration = {
      description: "Switch a demo device",
      arguments: { device: { kind: "enum" } },
      replyTemplate: "Switched {name}."
    };
    const discovery = classifierTools(classifier);
    // Give the enum argument a real schema enum so the SDK gate can accept it.
    (
      discovery.manifest.assistantTools![0]!.inputSchema as { properties: Record<string, unknown> }
    ).properties.device = { type: "string", enum: ["kitchen", "hall"] };
    const [manifest] = createExternalToolManifests([discovery], invoke);
    const tool = manifest?.assistantTools?.[0];
    expect(tool?.classifier?.description).toBe(classifier.description);
    expect(tool?.classifier?.replyTemplate).toBe(classifier.replyTemplate);
    expect(tool?.classifier?.candidates).toBeUndefined();
    expect(checkClassifierEligibility(tool as never)).toEqual({ eligible: true });
  });

  it("delegates a candidates hook to the invoker with the actor and signal", async () => {
    const signal = new AbortController().signal;
    const invokeCandidates = vi.fn().mockResolvedValue([{ id: "kitchen", label: "Kitchen" }]);
    const [manifest] = createExternalToolManifests(
      [classifierTools(candidatesClassifier)],
      invoke,
      invokeCandidates
    );
    const provider = manifest?.assistantTools?.[0]?.classifier?.candidates;
    expect(provider).toBeDefined();
    const result = await provider!({} as never, { actorUserId: "u1", requestId: "r1" } as never, {
      signal
    });
    expect(result).toEqual([{ id: "kitchen", label: "Kitchen" }]);
    expect(invokeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ id: "demo" }),
      "demo.devices",
      { actorUserId: "u1", requestId: "r1" },
      signal
    );
  });

  it("drops the candidates hook without an invoker, leaving the tool ineligible", () => {
    const [manifest] = createExternalToolManifests([classifierTools(candidatesClassifier)], invoke);
    const tool = manifest?.assistantTools?.[0];
    expect(tool?.classifier?.candidates).toBeUndefined();
    expect(checkClassifierEligibility(tool as never).eligible).toBe(false);
  });
});
