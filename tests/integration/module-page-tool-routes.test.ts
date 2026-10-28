// Real owner-scoped confirmation/audit storage. Auth and tool execution below are explicit
// stand-ins for route-policy tests T1–T13, not the installed-module browser proof (T14).
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AiRepository, createModulePageConfirmation } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";
import { registerModulePageToolRoutes } from "../../apps/api/src/module-page-tool-routes.js";
import { modulePageInputDigest } from "../../apps/api/src/module-page-tool-input.js";
import { ExternalModuleReportedError } from "../../apps/api/src/external-module-tools.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const origin = "http://localhost:5173";
const repository = new AiRepository();
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let server: FastifyInstance;
let active = true;
let tool: ModuleAssistantToolManifest;
const calls: Array<{ input: Record<string, unknown>; actorUserId: string }> = [];
const manifest = (id: string, tools: ModuleAssistantToolManifest[]) =>
  ({
    id,
    name: id === "demo" ? "Synthetic demo" : "Other synthetic module",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: tools
  }) as MossModuleManifest;

function fixtureTool(
  overrides: Partial<ModuleAssistantToolManifest> = {}
): ModuleAssistantToolManifest {
  return {
    name: "demo.change",
    permissionId: "demo.write",
    risk: "write",
    isExternal: true,
    description: "Change synthetic data",
    actionLabel: "Update synthetic data",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    outputSchema: {
      type: "object",
      properties: { saved: { type: "string" } },
      required: ["saved"]
    },
    execute: async (_scope, input, ctx) => {
      calls.push({ input, actorUserId: ctx.actorUserId });
      return { data: { saved: String(input.id), undeclared: "synthetic hidden field" } };
    },
    ...overrides
  };
}

async function makeServer() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  registerModulePageToolRoutes(app, {
    runner,
    repository,
    trustedOrigins: [origin],
    getExternalModuleIds: () => new Set(["demo", "other"]),
    resolveActiveModules: async () => [
      ...(active ? [manifest("demo", [tool])] : []),
      manifest("other", [fixtureTool({ name: "other.change" })]),
      manifest("builtin", [fixtureTool({ name: "builtin.change", isExternal: false })])
    ],
    resolveAccessContext: async (request) => {
      const actorUserId =
        request.headers.authorization === `Bearer ${ids.sessionA}`
          ? ids.userA
          : request.headers.authorization === `Bearer ${ids.sessionB}`
            ? ids.userB
            : null;
      if (!actorUserId) throw new Error("Unknown fixture session");
      return { actorUserId, requestId: String(request.headers["x-fixture-request-id"]) };
    }
  });
  await app.ready();
  return app;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  runner = new DataContextRunner(db);
  server = await makeServer();
});
beforeEach(() => {
  active = true;
  tool = fixtureTool();
  calls.length = 0;
});
afterAll(async () => {
  await server?.close();
  await db?.destroy();
});

async function invoke(
  options: {
    name?: string;
    moduleId?: string;
    input?: Record<string, unknown>;
    confirmationId?: string;
    actor?: "a" | "b";
    origin?: string | null;
    target?: FastifyInstance;
  } = {}
) {
  const requestId = randomUUID();
  const response = await (options.target ?? server).inject({
    method: "POST",
    url: `/api/modules/${options.moduleId ?? "demo"}/tools/${options.name ?? tool.name}/invoke`,
    headers: {
      authorization: `Bearer ${options.actor === "b" ? ids.sessionB : ids.sessionA}`,
      "x-fixture-request-id": requestId,
      ...(options.origin === null ? {} : { origin: options.origin ?? origin })
    },
    payload: {
      input: options.input ?? { id: "synthetic-row" },
      ...(options.confirmationId !== undefined ? { confirmationId: options.confirmationId } : {})
    }
  });
  return { response, requestId, body: response.json() };
}

function audits(requestId: string, actorUserId: string = ids.userA) {
  return runner.withDataContext({ actorUserId }, (scope) =>
    scope.db
      .selectFrom("app.moss_action_audit_log")
      .selectAll()
      .where("request_id", "=", requestId)
      .execute()
  );
}
function action(id: string) {
  return runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    repository.getAssistantAction(scope, id)
  );
}

describe("guarded module-page invoke route", () => {
  it("runs a direct write, projects output and records only metadata under its owner", async () => {
    const { response, body, requestId } = await invoke({
      input: { id: "synthetic-row", note: "PRIVATE-SYNTHETIC-NOTE" }
    });
    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      invocation: { status: "succeeded", result: { saved: "synthetic-row" } }
    });
    expect(calls).toHaveLength(1);
    const rows = await audits(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_user_id: ids.userA,
      tool_module_id: "demo",
      tool_name: tool.name,
      approval_mode: "auto",
      outcome: "success",
      source_surface: "module_page"
    });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE-SYNTHETIC-NOTE");
    expect(await audits(requestId, ids.userB)).toEqual([]);
  });

  it.each(["destructive", "outbound"] as const)(
    "always confirms %s and executes once with a committed decision",
    async (risk) => {
      tool = fixtureTool({ risk });
      const pending = await invoke();
      expect(pending.response.statusCode).toBe(409);
      expect(calls).toEqual([]);
      expect(await audits(pending.requestId)).toEqual([]);
      const confirmationId = pending.body.confirmation.id as string;
      const execute = tool.execute!;
      tool = {
        ...tool,
        execute: async (...args) => {
          expect((await action(confirmationId))?.status).toBe("confirmed");
          return execute(...args);
        }
      };
      const done = await invoke({ confirmationId });
      expect(done.response.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect((await audits(done.requestId))[0]).toMatchObject({
        approval_mode: "confirmed",
        outcome: "success"
      });
      expect((await invoke({ confirmationId })).body).toEqual({ code: "confirmation_invalid" });
      expect(calls).toHaveLength(1);
    }
  );

  it("refuses a tool owned by another module with the same 404 as missing and inactive modules", async () => {
    const other = await invoke({ name: "other.change" });
    const missing = await invoke({ moduleId: "missing" });
    const builtin = await invoke({ moduleId: "builtin", name: "builtin.change" });
    active = false;
    const inactive = await invoke();
    for (const result of [other, missing, builtin, inactive]) {
      expect(result.response.statusCode).toBe(404);
      expect(result.body).toEqual({ error: "Not found" });
    }
    expect(calls).toEqual([]);
  });

  it("admits only explicit external provenance", async () => {
    tool = fixtureTool({ isExternal: undefined });
    expect((await invoke()).response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it("consumes a confirmation exactly once under a race", async () => {
    tool = fixtureTool({ risk: "destructive" });
    const confirmationId = (await invoke()).body.confirmation.id as string;
    const results = await Promise.all([invoke({ confirmationId }), invoke({ confirmationId })]);
    expect(results.map((r) => r.response.statusCode).sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
    expect((await Promise.all(results.map((r) => audits(r.requestId)))).flat()).toHaveLength(1);
  });

  it("binds confirmation to input, actor and tool without consuming mismatches", async () => {
    tool = fixtureTool({ risk: "destructive" });
    const confirmationId = (await invoke()).body.confirmation.id as string;
    for (const options of [
      { input: { id: "different" } },
      { actor: "b" as const },
      { name: "other.change", moduleId: "other" }
    ])
      expect((await invoke({ ...options, confirmationId })).body).toEqual({
        code: "confirmation_invalid"
      });
    expect(calls).toEqual([]);
    expect((await action(confirmationId))?.status).toBe("pending");
    expect((await invoke({ confirmationId })).response.statusCode).toBe(200);
  });

  it("refuses chat, cancelled, expired and malformed confirmation ids", async () => {
    tool = fixtureTool({ risk: "destructive" });
    const page = (await invoke()).body.confirmation.id as string;
    const chat = await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      repository.createPendingAssistantAction(scope, {
        toolModuleId: "demo",
        toolModuleName: "Synthetic demo",
        toolName: tool.name,
        permissionId: tool.permissionId,
        risk: "destructive",
        inputSummary: {},
        chatThreadId: randomUUID(),
        chatSessionId: "synthetic-chat"
      })
    );
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      repository.resolveAssistantAction(scope, page, { status: "cancelled" })
    );
    const expired = await runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const created = await createModulePageConfirmation(scope, {
        moduleId: "demo",
        moduleName: "Synthetic demo",
        toolName: tool.name,
        permissionId: tool.permissionId,
        risk: "destructive",
        inputSummary: {},
        inputDigest: modulePageInputDigest({ id: "synthetic-row" }),
        requestId: randomUUID()
      });
      const original = await scope.db
        .selectFrom("app.ai_assistant_action_requests")
        .selectAll()
        .where("id", "=", created.id)
        .executeTakeFirstOrThrow();
      const id = randomUUID();
      await scope.db
        .insertInto("app.ai_assistant_action_requests")
        .values({ ...original, id, expires_at: sql<Date>`clock_timestamp() - interval '1 second'` })
        .execute();
      return id;
    });
    for (const confirmationId of [chat.id, page, expired, "not-a-uuid", randomUUID()])
      expect((await invoke({ confirmationId })).body).toEqual({ code: "confirmation_invalid" });
    expect(calls).toEqual([]);
  });

  it("fails closed for matching or throwing confirmation hooks, after validating input", async () => {
    for (const hook of [
      () => true,
      () => {
        throw new Error("synthetic lookup failure");
      }
    ]) {
      tool = fixtureTool({ requiresConfirmation: hook });
      expect((await invoke()).response.statusCode).toBe(409);
      expect((await invoke({ input: {} })).response.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("rejects missing and foreign Origin before execution", async () => {
    for (const value of [null, "https://untrusted.example"]) {
      const result = await invoke({ origin: value });
      expect(result.response.statusCode).toBe(403);
      expect(result.body).toEqual({ code: "invalid_origin" });
    }
    expect(calls).toEqual([]);
  });

  it("overrides caller-supplied actor identity", async () => {
    expect(
      (await invoke({ input: { id: "synthetic", actorUserId: ids.userB } })).response.statusCode
    ).toBe(200);
    expect(calls[0]).toMatchObject({ actorUserId: ids.userA, input: { actorUserId: ids.userA } });
  });

  it("screens module rejection codes and records failures rather than successes", async () => {
    for (const code of ["finance.duplicate", "PRIVATE SYNTHETIC MESSAGE"]) {
      tool = fixtureTool({
        execute: async () => {
          throw new ExternalModuleReportedError(code);
        }
      });
      const result = await invoke();
      expect(result.response.statusCode).toBe(422);
      expect(result.body).toEqual({
        code: "module_rejected",
        ...(code === "finance.duplicate" ? { moduleCode: code } : {})
      });
      expect((await audits(result.requestId))[0]).toMatchObject({
        outcome: "failed",
        error_class: "module_reported"
      });
      expect(JSON.stringify(await audits(result.requestId))).not.toContain(code);
    }
  });

  it("cannot replay a consumed approval after execution fails", async () => {
    const execute = vi.fn(async () => {
      throw new Error("PRIVATE-SYNTHETIC-ERROR");
    });
    tool = fixtureTool({ risk: "destructive", execute });
    const confirmationId = (await invoke()).body.confirmation.id as string;
    const failed = await invoke({ confirmationId });
    expect(failed.response.statusCode).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("PRIVATE-SYNTHETIC-ERROR");
    expect((await action(confirmationId))?.status).toBe("confirmed");
    expect((await audits(failed.requestId))[0]?.outcome).toBe("failed");
    expect((await invoke({ confirmationId })).response.statusCode).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("bounds and validates outputs and leaves reads off the write activity stream", async () => {
    tool = fixtureTool({ risk: "read" });
    const read = await invoke();
    expect(read.response.statusCode).toBe(200);
    expect(await audits(read.requestId)).toEqual([]);
    tool = fixtureTool({ execute: async () => ({ data: { saved: "x".repeat(2_000_001) } }) });
    expect((await invoke()).response.statusCode).toBe(413);
    tool = fixtureTool({ execute: async () => ({ data: { saved: 123 } }) });
    expect((await invoke()).response.statusCode).toBe(503);
  });

  it("uses a separate per-session and per-module rate-limit bucket", async () => {
    vi.stubEnv("JARVIS_RL_MODULE_TOOL_MAX", "2");
    const limited = await makeServer();
    vi.unstubAllEnvs();
    tool = fixtureTool({ risk: "read" });
    try {
      expect((await invoke({ target: limited })).response.statusCode).toBe(200);
      expect((await invoke({ target: limited })).response.statusCode).toBe(200);
      expect((await invoke({ target: limited })).response.statusCode).toBe(429);
      expect((await invoke({ target: limited, actor: "b" })).response.statusCode).toBe(200);
      expect(
        (await invoke({ target: limited, moduleId: "other", name: "other.change" })).response
          .statusCode
      ).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
