import { expect, it, vi } from "vitest";

import { createExternalToolManifests } from "@moss/module-registry/node";
import type { MossModuleManifest } from "@moss/module-sdk";
import { createExternalActiveModulesResolver } from "../../apps/api/src/external-module-tools.js";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";

const discovery: ExternalModuleDiscovery = {
  id: "acme",
  dir: "/modules/acme",
  manifest: {
    schemaVersion: 1,
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    lifecycle: "user-toggleable",
    compatibility: { jarv1s: ">=0.0.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    assistantTools: [
      {
        name: "acme.write",
        description: "Write",
        permissionId: "acme.write",
        risk: "write",
        handler: "write"
      }
    ]
  },
  manifestHash: "sha256:a",
  packageHash: "sha256:a"
};

it("adapts declarations into executable tools with parent-bound identity", async () => {
  const invoke = vi.fn(async () => ({ data: { ok: true } }));
  const [manifest] = createExternalToolManifests([discovery], invoke);
  expect(manifest).toMatchObject({
    id: "acme",
    availability: { supportsUserDisable: true },
    assistantTools: [{ name: "acme.write", risk: "write", isExternal: true }]
  });
  const execute = manifest?.assistantTools?.[0]?.execute;
  if (!execute) throw new Error("expected execute");
  const context = { actorUserId: "actor", requestId: "request", chatSessionId: "chat" };
  await execute({} as never, { moduleId: "evil" }, context, {});
  expect(invoke).toHaveBeenCalledWith(
    discovery,
    discovery.manifest.assistantTools?.[0],
    { moduleId: "evil" },
    context
  );
});

it("filters external modules without changing built-in action metadata", async () => {
  const builtIn = {
    id: "built-in",
    name: "Built in",
    version: "1.0.0",
    publisher: "Jarvis",
    lifecycle: "required",
    compatibility: { jarv1s: "*" },
    assistantActionFamilies: [
      {
        id: "writes",
        label: "Writes",
        description: "Write actions",
        defaultTier: "ask_each_time",
        allowedTiers: ["ask_each_time", "trusted_auto"]
      }
    ],
    assistantTools: [
      {
        name: "built-in.write",
        description: "Write",
        permissionId: "built-in.write",
        risk: "write",
        executionPolicy: "auto",
        actionFamilyId: "writes",
        execute: async () => ({ data: { ok: true } })
      }
    ]
  } satisfies MossModuleManifest;
  const external = { ...builtIn, id: "external", name: "External" };
  const resolve = createExternalActiveModulesResolver(
    async () => [builtIn, external],
    () => new Set([external.id]),
    async () => []
  );

  const resolved = await resolve("actor");
  expect(resolved).toEqual([builtIn]);
  expect(resolved[0]).toBe(builtIn);
  expect(resolved[0]?.assistantActionFamilies).toBe(builtIn.assistantActionFamilies);
  expect(resolved[0]?.assistantTools).toBe(builtIn.assistantTools);
});

it("passes actionLabel through the field-by-field remap", async () => {
  const labeledDiscovery: ExternalModuleDiscovery = {
    ...discovery,
    manifest: {
      ...discovery.manifest,
      assistantTools: [
        {
          name: "acme.write",
          description: "acme.write (1 field(s))",
          actionLabel: "Update your criteria",
          permissionId: "acme.write",
          risk: "write",
          handler: "write"
        }
      ]
    }
  };
  const invoke = vi.fn(async () => ({ data: { ok: true } }));
  const [manifest] = createExternalToolManifests([labeledDiscovery], invoke);
  expect(manifest?.assistantTools?.[0]).toMatchObject({
    name: "acme.write",
    actionLabel: "Update your criteria"
  });
});

it("keeps the original resolver when there are no external tool manifests", async () => {
  const manifests: MossModuleManifest[] = [];
  const enabled = vi.fn(async () => manifests);
  const external = vi.fn(async () => []);
  const resolve = createExternalActiveModulesResolver(enabled, () => new Set(), external);

  await expect(resolve("actor")).resolves.toBe(manifests);
  expect(external).not.toHaveBeenCalled();
});
