// Ben's ruling: Moss chat asks before recategorizing transactions, while a click on the
// Finance screen saves at once. Both facts come from the real shipped manifest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePolicy, type ActionPolicyLookup } from "../../packages/ai/src/gateway/policy.js";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";

import { registerModuleToolInvokeRoute } from "../../apps/api/src/external-module-tool-invoke.js";

vi.mock("@moss/settings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readActorLocale: vi.fn(async () => ({ timezone: "Pacific/Auckland" }))
}));

const ORIGIN = "http://moss.test";
const USER = "00000000-0000-4000-8000-0000000000a1";
const TOOLS = ["finance.transactions.confirm", "finance.transactions.bulk-category"] as const;

type Declared = {
  name: string;
  risk: ModuleAssistantToolManifest["risk"];
  actionFamilyId?: string;
  executionPolicy?: "auto" | "confirm";
  confirmWhenKeys?: string[];
};
type Shipped = {
  assistantTools: Declared[];
  assistantActionFamilies: {
    id: string;
    label: string;
    description: string;
    defaultTier: string;
    allowedTiers: string[];
  }[];
};

const shipped = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../external-modules/finance/jarvis.module.json", import.meta.url)),
    "utf8"
  )
) as Shipped;

const execute = vi.fn(async (..._args: unknown[]) => ({ data: { saved: true } }));

function shippedTool(name: string): ModuleAssistantToolManifest {
  const declared = shipped.assistantTools.find((tool) => tool.name === name)!;
  return {
    name,
    description: name,
    permissionId: name,
    risk: declared.risk,
    actionFamilyId: declared.actionFamilyId,
    executionPolicy: declared.executionPolicy,
    isExternal: true,
    actionLabel: name,
    inputSchema: { type: "object", properties: {} },
    execute: execute as never
  };
}

// The person has promoted the whole sorting family to run without asking, the widest
// setting the family allows. Chat must still ask for these two tools.
const promotedLookup: ActionPolicyLookup = {
  getFamilyTier: async () => "trusted_auto",
  getFamilyManifest: async (_moduleId, familyId) =>
    (shipped.assistantActionFamilies.find((family) => family.id === familyId) as never) ?? null
};

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  execute.mockClear();
});

describe("finance category changes: chat asks, screen click does not", () => {
  it.each(TOOLS)("chat asks before %s runs, even with the family promoted", async (name) => {
    const decision = await resolvePolicy(shippedTool(name), "finance", false, promotedLookup);
    expect(decision).toBe("confirm");
  });

  it.each(TOOLS)("the screen route runs %s on the click with no confirmation", async (name) => {
    const create = vi.fn();
    server = Fastify();
    await server.register(rateLimit, { global: false });
    registerModuleToolInvokeRoute(server, {
      auth: {
        resolveAccessContext: async () => ({ actorUserId: USER, requestId: "req-1" }),
        trustedOrigins: [ORIGIN]
      },
      resolveActiveModules: async () =>
        [
          { id: "finance", name: "Finance", version: "1.0.0", assistantTools: [shippedTool(name)] }
        ] as unknown as MossModuleManifest[],
      dataContext: { withDataContext: async (_access, work) => work({} as never) },
      confirmations: { create: create as never, consume: vi.fn() as never },
      recordActivity: vi.fn(async () => undefined) as never
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/api/modules/finance/tools/${name}/invoke`,
      headers: { origin: ORIGIN },
      payload: { input: { rows: [] } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      invocation: { status: "succeeded", result: { saved: true } }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves the sibling categorize tools as they were", () => {
    for (const name of ["finance.transaction.categorize", "finance.transaction.categorize-new"]) {
      const tool = shipped.assistantTools.find((entry) => entry.name === name);
      if (tool) expect(tool.executionPolicy).toBe("auto");
    }
  });
});
