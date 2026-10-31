// #3723: the route a downloaded module's own page uses to run that module's tools.
//
// Every guard here is asserted on the tool's side effect (the execute stub's call count), not
// only on the status code, so a build that answers 409 but still runs the tool fails.
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";
import { matchChatBlockedPathRule, PLATFORM_UNGUARDED_ROUTES } from "@moss/module-registry";

import {
  digestToolInput,
  registerModuleToolInvokeRoute,
  type ModuleToolInvokeDeps
} from "../../apps/api/src/external-module-tool-invoke.js";
import { ExternalModuleReportedError } from "../../apps/api/src/external-module-tools.js";

const { readActorLocale } = vi.hoisted(() => ({
  readActorLocale: vi.fn(async (_db: unknown) => ({ timezone: "Pacific/Auckland" }))
}));
vi.mock("@moss/settings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readActorLocale
}));

const ORIGIN = "http://moss.test";
const USER = "00000000-0000-4000-8000-0000000000a1";
const CONFIRMATION_ID = "00000000-0000-4000-8000-00000000c0f1";

const execute = vi.fn(
  async (..._args: unknown[]): Promise<{ data: Record<string, unknown> }> => ({
    data: { saved: true }
  })
);

function tool(
  name: string,
  risk: ModuleAssistantToolManifest["risk"],
  extra: Partial<ModuleAssistantToolManifest> = {}
): ModuleAssistantToolManifest {
  return {
    name,
    description: name,
    permissionId: `${name}.permission`,
    risk,
    isExternal: true,
    actionLabel: `Label for ${name}`,
    inputSchema: {
      type: "object",
      properties: { lineId: { type: "string" }, note: { type: "string" } },
      required: ["lineId"]
    },
    execute: execute as never,
    ...extra
  };
}

function manifest(id: string, tools: ModuleAssistantToolManifest[]): MossModuleManifest {
  return {
    id,
    name: id === "meals" ? "Meals" : id,
    version: "1.0.0",
    assistantTools: tools
  } as never;
}

let modules: MossModuleManifest[];
let server: FastifyInstance;
let create: ReturnType<typeof vi.fn>;
let consume: ReturnType<typeof vi.fn>;
let recordActivity: ReturnType<typeof vi.fn>;

async function build(overrides: Partial<ModuleToolInvokeDeps> = {}) {
  server = Fastify();
  await server.register(rateLimit, { global: false });
  registerModuleToolInvokeRoute(server, {
    auth: {
      resolveAccessContext: async () => ({ actorUserId: USER, requestId: "req-1" }),
      trustedOrigins: [ORIGIN]
    },
    resolveActiveModules: async () => modules,
    dataContext: { withDataContext: async (_access, work) => work({} as never) },
    confirmations: { create: create as never, consume: consume as never },
    recordActivity: recordActivity as never,
    ...overrides
  });
  await server.ready();
}

function call(
  moduleId: string,
  name: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = { origin: ORIGIN }
) {
  return server.inject({
    method: "POST",
    url: `/api/modules/${moduleId}/tools/${name}/invoke`,
    headers,
    payload
  });
}

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ data: { saved: true } });
  create = vi.fn(async () => ({
    id: CONFIRMATION_ID,
    expiresAt: new Date("2026-10-31T12:02:00.000Z")
  }));
  consume = vi.fn(async () => true);
  recordActivity = vi.fn(async () => undefined);
  modules = [
    manifest("meals", [
      tool("meals.tickLine", "write"),
      tool("meals.readPlan", "read"),
      tool("meals.deletePlan", "destructive"),
      tool("meals.sendList", "outbound"),
      tool("meals.renamePlan", "write", { requiresConfirmation: () => true }),
      tool("meals.flakyRule", "write", {
        requiresConfirmation: () => {
          throw new Error("rule lookup failed");
        }
      }),
      tool("meals.quietRule", "write", { requiresConfirmation: () => false })
    ]),
    manifest("pantry", [tool("pantry.dropItem", "write")]),
    manifest("tasks", [tool("tasks.create", "write", { isExternal: false })])
  ];
});

afterEach(async () => {
  await server?.close();
  delete process.env.JARVIS_RL_MODULE_TOOL_MAX;
});

describe("module page tool route: direct runs", () => {
  it("T1 runs a write with no confirm rule once and returns its result", async () => {
    await build();
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      invocation: { status: "succeeded", result: { saved: true } }
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({
      moduleId: "meals",
      toolName: "meals.tickLine",
      actionKind: "write",
      approvalMode: "auto",
      outcome: "success",
      errorClass: null,
      inputSummary: { inputKeys: ["lineId"], inputKeyCount: 1, truncated: false }
    });
  });

  it("runs a read tool and records no activity", async () => {
    await build();
    const response = await call("meals", "meals.readPlan", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("runs a write whose own confirm rule answers false", async () => {
    await build();
    const response = await call("meals", "meals.quietRule", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("T11 hands the tool the session actor, never one named in the input", async () => {
    await build();
    await call("meals", "meals.tickLine", {
      input: { lineId: "l1", actorUserId: "00000000-0000-4000-8000-0000000000b2" }
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0]![2] as { actorUserId: string }).actorUserId).toBe(USER);
  });

  it("hands the tool the session actor's saved locale and timezone", async () => {
    const actorDb = { scope: "actor" };
    await build({
      dataContext: { withDataContext: async (_access, work) => work(actorDb as never) }
    });
    await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(readActorLocale).toHaveBeenCalledWith(actorDb);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![2]).toMatchObject({
      locale: { timezone: "Pacific/Auckland" },
      localTimezone: "Pacific/Auckland"
    });
  });

  it("reads the time zone as the signed-in person", async () => {
    readActorLocale.mockClear();
    await build({
      dataContext: {
        withDataContext: async (access, work) => work({ actor: access.actorUserId } as never)
      }
    });
    await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(readActorLocale).toHaveBeenCalledTimes(1);
    expect(readActorLocale.mock.calls[0]![0]).toEqual({ actor: USER });
  });

  it("stops the call when the saved locale cannot be read", async () => {
    await build();
    readActorLocale.mockRejectedValueOnce(new Error("locale read failed"));
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(500);
    expect(execute).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("module page tool route: confirmation", () => {
  it("T2 never runs a destructive tool without a confirmation", async () => {
    await build();
    const response = await call("meals", "meals.deletePlan", { input: { lineId: "p1" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      invocation: { status: "blocked", reason: "confirmation_required" },
      confirmation: {
        id: CONFIRMATION_ID,
        expiresAt: "2026-10-31T12:02:00.000Z",
        moduleName: "Meals",
        actionLabel: "Label for meals.deletePlan",
        risk: "destructive",
        inputSummary: { inputKeys: ["lineId"], inputKeyCount: 1, truncated: false }
      }
    });
    expect(execute).toHaveBeenCalledTimes(0);
    expect(recordActivity).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({
      moduleId: "meals",
      moduleName: "Meals",
      toolName: "meals.deletePlan",
      permissionId: "meals.deletePlan.permission",
      risk: "destructive",
      inputDigest: digestToolInput({ lineId: "p1" })
    });
  });

  it("asks before an outbound tool, even on a Send click", async () => {
    await build();
    const response = await call("meals", "meals.sendList", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(409);
    expect(response.json().confirmation.risk).toBe("outbound");
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("T8 asks when a write's own rule matches, and when the rule throws", async () => {
    await build();
    const matched = await call("meals", "meals.renamePlan", { input: { lineId: "p1" } });
    const thrown = await call("meals", "meals.flakyRule", { input: { lineId: "p1" } });

    expect(matched.statusCode).toBe(409);
    expect(matched.json().confirmation.risk).toBe("write");
    expect(thrown.statusCode).toBe(409);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("runs once after a valid confirmation and records it as confirmed", async () => {
    await build();
    const response = await call("meals", "meals.deletePlan", {
      input: { lineId: "p1" },
      confirmationId: CONFIRMATION_ID
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(consume.mock.calls[0]![1]).toEqual({
      id: CONFIRMATION_ID,
      moduleId: "meals",
      toolName: "meals.deletePlan",
      inputDigest: digestToolInput({ lineId: "p1" })
    });
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({
      actionKind: "destructive",
      approvalMode: "confirmed",
      outcome: "success"
    });
  });

  it("refuses an unusable confirmation and runs nothing", async () => {
    consume.mockResolvedValue(false);
    await build();
    const response = await call("meals", "meals.sendList", {
      input: { lineId: "l1" },
      confirmationId: CONFIRMATION_ID
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("binds the digest to input regardless of key order", () => {
    expect(digestToolInput({ a: 1, b: { d: [1, { f: 2, e: 3 }], c: "x" } })).toEqual(
      digestToolInput({ b: { c: "x", d: [1, { e: 3, f: 2 }] }, a: 1 })
    );
    expect(digestToolInput({ lineId: "p1" })).not.toEqual(digestToolInput({ lineId: "p2" }));
  });
});

describe("module page tool route: admission", () => {
  it("T3 refuses another module's tool named through this module's path", async () => {
    await build();
    const response = await call("meals", "pantry.dropItem", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("T9 answers an inactive module exactly as an unknown one", async () => {
    await build();
    const unknown = await call("nosuch", "nosuch.tool", { input: { lineId: "l1" } });
    modules = modules.filter((module) => module.id !== "meals");
    const inactive = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });
    const unknownTool = await call("pantry", "pantry.nosuch", { input: { lineId: "l1" } });

    for (const response of [unknown, inactive, unknownTool]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(unknown.body);
    }
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("refuses a built-in module's tool", async () => {
    await build();
    const response = await call("tasks", "tasks.create", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(404);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("T10 refuses a missing or foreign Origin before running anything", async () => {
    await build();
    const missing = await call("meals", "meals.tickLine", { input: { lineId: "l1" } }, {});
    const foreign = await call(
      "meals",
      "meals.tickLine",
      { input: { lineId: "l1" } },
      { origin: "https://evil.example" }
    );

    for (const response of [missing, foreign]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "invalid_origin" });
    }
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("answers 401 without a session", async () => {
    await build({
      auth: {
        resolveAccessContext: async () => {
          throw new Error("no session");
        },
        trustedOrigins: [ORIGIN]
      }
    });
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(401);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("validates input before asking, so bad input never opens a dialog", async () => {
    await build();
    const response = await call("meals", "meals.deletePlan", { input: { note: "no id" } });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("refuses a malformed body", async () => {
    await build();
    for (const payload of [
      { input: [] },
      { input: { lineId: "l1" }, extra: true },
      { input: { lineId: "l1" }, confirmationId: 7 },
      { input: { lineId: "l1" }, confirmationId: "x".repeat(65) }
    ]) {
      const response = await call("meals", "meals.tickLine", payload);
      expect(response.statusCode).toBe(400);
    }
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("rate-limits per session and module", async () => {
    process.env.JARVIS_RL_MODULE_TOOL_MAX = "2";
    await build();
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push(
        (await call("meals", "meals.tickLine", { input: { lineId: "l1" } })).statusCode
      );
    }
    const otherModule = await call("pantry", "pantry.dropItem", { input: { lineId: "l1" } });

    expect(statuses).toEqual([200, 200, 429]);
    expect(otherModule.statusCode).toBe(200);
  });

  it.each(["0", "-5", "abc", "2.5"])(
    "keeps the default limit of 120 when the override is %s",
    async (override) => {
      process.env.JARVIS_RL_MODULE_TOOL_MAX = override;
      await build();
      const statuses: number[] = [];
      for (let index = 0; index < 121; index += 1) {
        statuses.push(
          (await call("meals", "meals.readPlan", { input: { lineId: "l1" } })).statusCode
        );
      }

      expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
      expect(statuses[120]).toBe(429);
    }
  );
});

describe("module page tool route: failures", () => {
  it("T12 passes an identifier-shaped module code and drops free text", async () => {
    await build();
    execute.mockRejectedValueOnce(new ExternalModuleReportedError("pantry.duplicate"));
    const coded = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });
    execute.mockRejectedValueOnce(new ExternalModuleReportedError("Your list <b>is</b> gone"));
    const freeText = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(coded.statusCode).toBe(422);
    expect(coded.json()).toEqual({ code: "module_rejected", moduleCode: "pantry.duplicate" });
    expect(freeText.statusCode).toBe(422);
    expect(freeText.json()).toEqual({ code: "module_rejected" });
    expect(recordActivity.mock.calls.map((args) => args[1])).toEqual([
      expect.objectContaining({ outcome: "failed", errorClass: "module_rejected" }),
      expect.objectContaining({ outcome: "failed", errorClass: "module_rejected" })
    ]);
  });

  it("hides a thrown error's text and records the failure", async () => {
    await build();
    execute.mockRejectedValueOnce(new Error("secret path /var/lib/x"));
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("secret");
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({
      outcome: "failed",
      errorClass: "handler_error"
    });
  });

  it("answers 413 for a result too large to return, recording the write that ran", async () => {
    await build();
    execute.mockResolvedValueOnce({ data: { blob: "x".repeat(2_000_000) } });
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "result_too_large", saved: true });
    expect(recordActivity.mock.calls[0]![1]).toMatchObject({ outcome: "success" });
  });

  it("tells the page a too-large read changed nothing", async () => {
    await build();
    execute.mockResolvedValueOnce({ data: { blob: "x".repeat(2_000_000) } });
    const response = await call("meals", "meals.readPlan", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "result_too_large", saved: false });
  });

  it("still answers success when the activity record fails to save", async () => {
    recordActivity.mockRejectedValue(new Error("db down"));
    await build();
    const response = await call("meals", "meals.tickLine", { input: { lineId: "l1" } });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("module page tool route: platform rules", () => {
  it("T13 blocks Moss from calling the route through the app's own API", () => {
    expect(
      matchChatBlockedPathRule("POST", "/api/modules/:moduleId/tools/:name/invoke")?.category
    ).toBe("self_authority");
    expect(
      matchChatBlockedPathRule("POST", "/api/modules/meals/tools/meals.x/invoke")?.category
    ).toBe("self_authority");
  });

  it("is a platform route owned by no module", () => {
    expect(PLATFORM_UNGUARDED_ROUTES.has("POST /api/modules/:moduleId/tools/:name/invoke")).toBe(
      true
    );
  });
});
