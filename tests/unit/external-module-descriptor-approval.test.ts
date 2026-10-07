import { describe, expect, it } from "vitest";

import { reconcileExternalModules } from "@moss/module-registry";
import type { ExternalModuleDiscovery, ExternalModuleStateInput } from "@moss/module-registry";
import { createExternalToolManifests, hashCanonicalManifest } from "@moss/module-registry/node";
import type { JsonSchema, MossModuleManifest } from "@moss/module-sdk";
import { createExternalActiveModulesResolver } from "../../apps/api/src/external-module-tools.js";

const OWNER = "owner-a";
const OTHER = "owner-b";

function nestedKeySchema(schema: JsonSchema | undefined): object {
  if (
    !schema ||
    typeof schema.properties !== "object" ||
    schema.properties === null ||
    !("key" in schema.properties)
  ) {
    throw new Error("Expected fixture key schema");
  }
  const key = schema.properties.key;
  if (typeof key !== "object" || key === null) throw new Error("Expected object key schema");
  return key;
}

function discovery(): ExternalModuleDiscovery {
  const manifest: ExternalModuleDiscovery["manifest"] = {
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    assistantTools: [
      {
        name: "demo.read",
        description: "Read demo",
        permissionId: "demo.read",
        risk: "read",
        handler: "read",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Choose a key", enum: ["one", "two"] }
          }
        },
        classifier: {
          description: "Read demo",
          arguments: { key: { kind: "enum" } },
          replyTemplate: "Read."
        }
      }
    ]
  };
  return {
    id: "demo",
    dir: "/modules/demo",
    manifest,
    manifestHash: hashCanonicalManifest(manifest),
    packageHash: "sha256:package"
  };
}

function accepted(
  module: ExternalModuleDiscovery,
  overrides: Partial<ExternalModuleStateInput> = {}
): ExternalModuleStateInput {
  return {
    id: module.id,
    status: "enabled",
    packageHash: module.packageHash,
    manifestHash: module.manifestHash,
    descriptorApprovedByUserId: OWNER,
    disabledReason: null,
    ownerUserId: null,
    ...overrides
  };
}

function resolver(
  module: ExternalModuleDiscovery,
  state: ExternalModuleStateInput,
  manifests?: readonly MossModuleManifest[]
) {
  const generated =
    manifests ?? createExternalToolManifests([module], async () => ({ data: { outside: true } }));
  return createExternalActiveModulesResolver(
    async () => generated,
    () => new Set([module.id]),
    async () => reconcileExternalModules([module], [state]).modules.filter((entry) => entry.active)
  );
}

const stamp = (modules: readonly MossModuleManifest[]) =>
  modules[0]?.assistantTools?.[0]?.descriptorOwnerUserId;

describe("accepted add-on descriptor ownership", () => {
  it("stamps owner descriptors on actor-local copies without trusting results", async () => {
    const module = discovery();
    const generated = createExternalToolManifests([module], async () => ({
      data: { outside: true }
    }));
    const resolve = resolver(module, accepted(module), generated);
    const [owner, other] = await Promise.all([resolve(OWNER), resolve(OTHER)]);
    expect(stamp(owner)).toBe(OWNER);
    expect(stamp(other)).toBeUndefined();
    expect(stamp(generated)).toBeUndefined();
    expect(owner[0]).not.toBe(generated[0]);
    expect(owner[0]?.assistantTools?.[0]).toMatchObject({ isExternal: true });
    expect(owner[0]?.assistantTools?.[0]?.content).toBeUndefined();
    expect(owner[0]?.assistantTools?.[0]?.safeErrors).toBeUndefined();
    expect(stamp(await resolve(OTHER))).toBeUndefined();
  });

  it.each([
    ["legacy unknown installer", { descriptorApprovedByUserId: null }],
    ["missing accepted manifest", { manifestHash: undefined }],
    ["unapproved manifest drift", { manifestHash: "sha256:previous" }],
    ["another admin's installation", { descriptorApprovedByUserId: OTHER }],
    ["draft ownership alone", { status: "draft", ownerUserId: OWNER }]
  ] as const)("does not trust %s", async (_label, overrides) => {
    const module = discovery();
    expect(stamp(await resolver(module, accepted(module, overrides))(OWNER))).toBeUndefined();
  });

  it("removes an unapproved package from the active list", async () => {
    const module = discovery();
    expect(await resolver(module, accepted(module, { packageHash: "sha256:old" }))(OWNER)).toEqual(
      []
    );
  });

  it("does not transfer A's descriptor trust to B's newly accepted upgrade", async () => {
    const module = discovery();
    const resolve = resolver(module, accepted(module, { descriptorApprovedByUserId: OTHER }));
    expect(stamp(await resolve(OWNER))).toBeUndefined();
    expect(stamp(await resolve(OTHER))).toBe(OTHER);
  });

  it.each(["nested schema", "classifier"])("refuses %s changes after discovery", async (kind) => {
    const module = discovery();
    const tool = module.manifest.assistantTools![0]!;
    if (kind === "nested schema")
      Object.assign(nestedKeySchema(tool.inputSchema), { description: "Changed" });
    else Object.assign(tool.classifier!, { description: "Changed" });
    expect(stamp(await resolver(module, accepted(module))(OWNER))).toBeUndefined();
  });

  it.each(["nested schema", "classifier"])("refuses %s changes after synthesis", async (kind) => {
    const module = discovery();
    const generated = createExternalToolManifests([module], async () => ({ data: {} }));
    const tool = generated[0]!.assistantTools![0]!;
    if (kind === "nested schema")
      Object.assign(nestedKeySchema(tool.inputSchema), { description: "Changed" });
    else Object.assign(tool.classifier!, { description: "Changed" });
    expect(stamp(await resolver(module, accepted(module), generated)(OWNER))).toBeUndefined();
  });

  it("ignores a forged JSON owner stamp and forged synthesized manifest metadata", async () => {
    const module = discovery();
    Object.assign(module.manifest.assistantTools![0]!, { descriptorOwnerUserId: OWNER });
    const generated = createExternalToolManifests([module], async () => ({ data: {} }));
    expect(stamp(generated)).toBeUndefined();
    Object.assign(generated[0]!.assistantTools![0]!, { descriptorOwnerUserId: OWNER });
    expect(stamp(await resolver(module, accepted(module), generated)(OWNER))).toBeUndefined();
  });

  it("detaches approved descriptor data from shared registry references", async () => {
    const module = discovery();
    const generated = createExternalToolManifests([module], async () => ({ data: {} }));
    const resolved = await resolver(module, accepted(module), generated)(OWNER);
    const shared = generated[0]!.assistantTools![0]!;
    const own = resolved[0]!.assistantTools![0]!;
    Object.assign(nestedKeySchema(shared.inputSchema), { description: "Changed later" });
    Object.assign(shared.classifier!, { description: "Changed later" });
    expect(nestedKeySchema(own.inputSchema)).toMatchObject({ description: "Choose a key" });
    expect(own.classifier?.description).toBe("Read demo");
  });

  it.each(["manifest", "package"] as const)(
    "refuses a concurrent rescan when only the %s hash differs",
    async (changedHash) => {
      const first = discovery();
      const nextManifest =
        changedHash === "manifest" ? { ...first.manifest, version: "2.0.0" } : first.manifest;
      const next: ExternalModuleDiscovery = {
        ...first,
        manifest: nextManifest,
        manifestHash: hashCanonicalManifest(nextManifest),
        packageHash: changedHash === "package" ? "sha256:next" : first.packageHash
      };
      // Resolve the current accepted discovery separately from the earlier tool snapshot.
      // Exactly one binding differs, so the other guard cannot mask its removal.
      const [active] = reconcileExternalModules([next], [accepted(next)]).modules;
      expect(active).toMatchObject({ active: true, descriptorApprovedByUserId: OWNER });
      if (changedHash === "manifest") {
        expect(next.manifestHash).not.toBe(first.manifestHash);
        expect(next.packageHash).toBe(first.packageHash);
      } else {
        expect(next.manifestHash).toBe(first.manifestHash);
        expect(next.packageHash).not.toBe(first.packageHash);
      }
      const generated = createExternalToolManifests([first], async () => ({ data: {} }));
      const resolve = createExternalActiveModulesResolver(
        async () => {
          await Promise.resolve();
          return generated;
        },
        () => new Set([first.id]),
        async () => (active ? [active] : [])
      );
      const resolved = await resolve(OWNER);
      expect(resolved).toHaveLength(1);
      expect(stamp(resolved)).toBeUndefined();
    }
  );
});
