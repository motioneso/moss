import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";
import { getBuiltInModuleManifests, validateExternalModuleManifest } from "@moss/module-registry";

import { createExternalToolManifests } from "../../packages/module-registry/src/external/tool-manifests.js";
import { isSelfOperationExcluded } from "../../packages/ai/src/gateway/self-operation.js";
import {
  admissionFixture,
  admissionModule,
  admissionTool,
  rejectAdmissionCard,
  resolvedCall
} from "./helpers/gateway-admission-fixture.js";

const externalRoot = new URL("../../external-modules/", import.meta.url);
const externalModules = createExternalToolManifests(
  readdirSync(externalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const dir = new URL(`${name}/`, externalRoot);
      const raw: unknown = JSON.parse(readFileSync(new URL("jarvis.module.json", dir), "utf8"));
      const validated = validateExternalModuleManifest(raw, name, "0.1.0");
      if (!validated.ok) throw new Error(`Invalid shipped module ${name}`);
      return {
        id: name,
        dir: fileURLToPath(dir),
        manifest: validated.manifest,
        manifestHash: "fixture-manifest",
        packageHash: "fixture-package"
      };
    }),
  async () => ({ data: {} })
);
const shippedWrites = [...getBuiltInModuleManifests(), ...externalModules].flatMap((module) =>
  (module.assistantTools ?? [])
    .filter((tool) => tool.risk !== "read" && typeof tool.execute === "function")
    .map((tool) => ({ name: tool.name, module, tool }))
);
const callableWrites = shippedWrites.filter(
  ({ module, tool }) => !isSelfOperationExcluded(module.id, tool)
);
const excludedWrites = shippedWrites.filter(({ module, tool }) =>
  isSelfOperationExcluded(module.id, tool)
);

type Tier = "ask_each_time" | "trusted_auto";

function setup(
  module: MossModuleManifest,
  declared: ModuleAssistantToolManifest,
  yolo: boolean,
  tier: Tier = "trusted_auto"
) {
  const execute = vi.fn(async () => ({ data: { changed: true } }));
  const requiresConfirmation = vi.fn(async () => false);
  const runsWithoutAsking = vi.fn(async () => true);
  // Exercise every real policy declaration through the gateway without executing a module or
  // reproducing its input/preview fixtures. Schemas, presentation and handlers are stand-ins;
  // risk, origin, action family, execution policy, exclusions and required services are retained.
  // Other approval hooks are deliberately permissive so they cannot mask a missing taint floor.
  const tool: ModuleAssistantToolManifest = {
    ...declared,
    inputSchema: { type: "object", properties: {} },
    summarize: () => declared.name,
    preview: undefined,
    actionLabel: "Apply fixture action",
    approvalContent: "user_authored",
    approvalPresentation: async () => ({ target: "Fixture target", fields: [] }),
    requiresConfirmation,
    runsWithoutAsking,
    execute
  };
  const outsideRead = admissionTool("fixture.outsideRead", { content: "outside" });
  const services = Object.fromEntries((tool.requiresServices ?? []).map((key) => [key, {}]));
  const yoloMode = vi.fn(async () => yolo);
  const getFamilyTier = vi.fn(async (): Promise<Tier> => tier);
  // The fixture tools name the shared "change" family, which a real module declares.
  const getFamilyManifest = vi.fn(
    async (_module: string, id: string) =>
      module.assistantActionFamilies?.find((family) => family.id === id) ??
      (id === "change"
        ? {
            id: "change",
            label: "Change",
            description: "Change settings",
            defaultTier: "ask_each_time" as const,
            allowedTiers: ["ask_each_time" as const, "trusted_auto" as const]
          }
        : null)
  );
  const h = admissionFixture([], {
    deps: {
      resolveActiveModules: async () => [{ ...module, assistantTools: [tool, outsideRead] }],
      toolServices: services,
      yoloMode,
      actionPolicy: () => ({ getFamilyTier, getFamilyManifest }),
      ...(tool.requiresPerCallResolution
        ? {
            perCallResolvers: {
              [tool.name]: async () => resolvedCall({ risk: tool.risk })
            },
            perCallServices: { [tool.name]: () => services },
            perCallExecutors: { [tool.name]: execute }
          }
        : {})
    }
  });
  return {
    ...h,
    tool,
    execute,
    outsideRead,
    requiresConfirmation,
    runsWithoutAsking,
    yoloMode,
    getFamilyTier,
    getFamilyManifest
  };
}

async function admitOutside(h: ReturnType<typeof setup>) {
  expect(await h.gateway.callTool(h.token, h.outsideRead.name, {})).toMatchObject({ ok: true });
  expect(h.state.tainted).toBe(true);
  expect(h.recordAdmission).toHaveBeenCalledWith("actor-a", "thread-a", "tool_external_content");
}

async function expectWriteHeld(h: ReturnType<typeof setup>) {
  for (const mode of ["dry-run", "execute"] as const) {
    expect(await h.gateway.callToolForGate(h.token, h.tool.name, {}, mode)).toEqual({
      kind: "declined",
      reason: "would_confirm"
    });
  }
  expect(h.records).toEqual([]);
  expect(h.createPending).not.toHaveBeenCalled();
  const pending = h.gateway.callTool(h.token, h.tool.name, {});
  await rejectAdmissionCard(h, pending);
  expect(await pending).toMatchObject({
    ok: false,
    denied: true,
    reason: expect.stringContaining("Do not try it again")
  });
  expect(h.createPending).toHaveBeenCalledOnce();
  expect(h.records).toContainEqual(
    expect.objectContaining({
      kind: "action_request",
      toolName: h.tool.name,
      outsideContentNotice: true
    })
  );
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.runAutomatic).not.toHaveBeenCalled();
}

async function gateDryRun(h: ReturnType<typeof setup>) {
  return h.gateway.callToolForGate(h.token, h.tool.name, {}, "dry-run");
}

describe("outside-content confirmation across every shipped write declaration", () => {
  it("includes both the generic app route and dedicated auto-capable writes", () => {
    expect(callableWrites.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "app.callAction",
        "settings.themeMode.set",
        "tasks.create",
        "finance.budget.assign",
        "food.meals.log",
        "job-search.profile.create"
      ])
    );
  });

  it.each(callableWrites)(
    "$name asks after outside content unless the user trusted it",
    async ({ module, tool }) => {
      const h = setup(module, tool, false, "ask_each_time");
      await admitOutside(h);
      await expectWriteHeld(h);
    }
  );

  it.each(callableWrites)(
    "$name runs after outside content only where the user's trust runs it in a clean chat",
    async ({ module, tool }) => {
      for (const yolo of [false, true]) {
        const clean = await gateDryRun(setup(module, tool, yolo));
        const h = setup(module, tool, yolo);
        await admitOutside(h);
        const tainted = await gateDryRun(h);
        if (tainted.kind === "would_run") expect(clean).toEqual(tainted);
        if (tool.risk !== "write" || (tool.name === "app.callAction" && !yolo)) {
          expect(tainted).toEqual({ kind: "declined", reason: "would_confirm" });
        }
      }
    }
  );

  it.each(excludedWrites)(
    "$name remains unavailable after outside content",
    async ({ module, tool }) => {
      const h = setup(module, tool, true);
      await admitOutside(h);
      expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: false });
      for (const mode of ["dry-run", "execute"] as const) {
        expect(await h.gateway.callToolForGate(h.token, tool.name, {}, mode)).toEqual({
          kind: "declined",
          reason: "not_available"
        });
      }
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );
});

const externalWrites = [
  { name: "connected.write", risk: "write", descriptorOwnerUserId: "actor-a" },
  { name: "connected.outbound", risk: "outbound", descriptorOwnerUserId: "actor-a" },
  { name: "addon.write", risk: "write", descriptorOwnerUserId: "actor-a" },
  { name: "unknown.write", risk: "write", descriptorOwnerUserId: undefined },
  { name: "foreign.write", risk: "write", descriptorOwnerUserId: "actor-b" }
] as const;

describe("the user's trust after outside content", () => {
  const move = callableWrites.find(({ name }) => name === "finance.budget.move")!;

  it.each([false, true])(
    "a promoted family runs without claiming a clean chat (YOLO=%s)",
    async (yolo) => {
      const h = setup(move.module, move.tool, yolo);
      await admitOutside(h);
      expect(await gateDryRun(h)).toEqual({
        kind: "would_run",
        approvalMode: yolo ? "yolo" : "auto"
      });
      expect(await h.gateway.callTool(h.token, move.tool.name, {})).toMatchObject({ ok: true });
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.runAutomatic).not.toHaveBeenCalled();
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])("a per-call limit still asks (YOLO=%s)", async (yolo) => {
    const h = setup(move.module, move.tool, yolo);
    h.requiresConfirmation.mockResolvedValue(true);
    await admitOutside(h);
    await expectWriteHeld(h);
  });

  it("outbound and destructive writes ask under YOLO", async () => {
    for (const risk of ["outbound", "destructive"] as const) {
      const tool = admissionTool(`fixture.${risk}`, { risk });
      const h = setup(admissionModule([tool]), tool, true);
      await admitOutside(h);
      await expectWriteHeld(h);
    }
  });
});

describe("outside-content confirmation also covers external write origins", () => {
  it.each(externalWrites)("$name cannot use sorted-safe to bypass the floor", async (entry) => {
    const tool = admissionTool(entry.name, { ...entry, isExternal: true });
    const h = setup(admissionModule([tool]), tool, false, "ask_each_time");
    await admitOutside(h);
    await expectWriteHeld(h);
  });

  it.each(externalWrites)(
    "$name retains clean automatic dispatch before its result taints",
    async (entry) => {
      const tool = admissionTool(entry.name, { ...entry, isExternal: true });
      for (const yolo of [false, true]) {
        const h = setup(admissionModule([tool]), tool, yolo);
        expect(await h.gateway.callToolForGate(h.token, tool.name, {}, "dry-run")).toEqual({
          kind: "would_run",
          approvalMode: yolo ? "yolo" : "auto"
        });
        expect(await h.gateway.callTool(h.token, tool.name, {})).toMatchObject({ ok: true });
        expect(h.execute).toHaveBeenCalledOnce();
        expect(h.runAutomatic).toHaveBeenCalledOnce();
        expect(h.createPending).not.toHaveBeenCalled();
        expect(h.state.tainted).toBe(true);
      }
    }
  );
});
