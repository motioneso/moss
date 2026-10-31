// #3723: the module page tool route against the real action table, activity log and owner RLS.
//
// The route runs on its own server with the production confirmation and activity functions; only
// the module's worker is a stub, so every assertion about "ran" is the stub's call count.
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";

import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  digestToolInput,
  registerModuleToolInvokeRoute
} from "../../apps/api/src/external-module-tool-invoke.js";
import { ExternalModuleReportedError } from "../../apps/api/src/external-module-tools.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const ORIGIN = "http://moss.test";
const ACTORS: Record<string, string> = { "user-a": ids.userA, "user-b": ids.userB };
// Every call in one test carries this request id, so activity reads see only that test's rows.
let testRun = randomUUID();
const execute = vi.fn(async (..._args: unknown[]) => ({ data: { done: true } }));

function tool(
  name: string,
  risk: ModuleAssistantToolManifest["risk"]
): ModuleAssistantToolManifest {
  return {
    name,
    description: name,
    permissionId: "meals.plan",
    actionFamilyId: "meals.plan",
    risk,
    isExternal: true,
    actionLabel: "Delete this plan",
    inputSchema: {
      type: "object",
      properties: { planId: { type: "string" } },
      required: ["planId"]
    },
    execute: execute as never
  };
}

const meals = {
  id: "meals",
  name: "Meals",
  version: "1.0.0",
  assistantTools: [
    tool("meals.deletePlan", "destructive"),
    tool("meals.sendList", "outbound"),
    tool("meals.tickLine", "write")
  ]
} as unknown as MossModuleManifest;

const repository = new AiRepository();
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let boss: PgBoss;
let api: ReturnType<typeof createApiServer>;
let route: FastifyInstance;

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  runner = new DataContextRunner(db);
  boss = createPgBossClient(connectionStrings.app);
  api = createApiServer({ appDb: db, boss, logger: false });
  await api.ready();
  route = Fastify();
  await route.register(rateLimit, { global: false });
  registerModuleToolInvokeRoute(route, {
    auth: {
      resolveAccessContext: async (request) => {
        const actorUserId = ACTORS[String(request.headers["x-test-actor"])];
        if (!actorUserId) throw new Error("no session");
        return { actorUserId, requestId: testRun };
      },
      trustedOrigins: [ORIGIN]
    },
    resolveActiveModules: async () => [meals],
    dataContext: runner
  });
  await route.ready();
});

afterAll(async () => {
  await route?.close();
  await api?.close();
  await boss?.stop({ graceful: false });
  await db?.destroy();
});

beforeEach(() => {
  testRun = randomUUID();
  execute.mockReset();
  execute.mockResolvedValue({ data: { done: true } });
});

function invoke(
  name: string,
  payload: Record<string, unknown>,
  actor: "user-a" | "user-b" = "user-a"
) {
  return route.inject({
    method: "POST",
    url: `/api/modules/meals/tools/${name}/invoke`,
    headers: { origin: ORIGIN, "x-test-actor": actor },
    payload
  });
}

async function ask(name = "meals.deletePlan", input = { planId: "plan-1" }) {
  const response = await invoke(name, { input });
  expect(response.statusCode).toBe(409);
  return response.json().confirmation.id as string;
}

function activityFor(actorUserId: string, toolName: string) {
  return runner.withDataContext({ actorUserId }, (scope) =>
    scope.db
      .selectFrom("app.moss_action_audit_log")
      .select([
        "owner_user_id",
        "approval_mode",
        "outcome",
        "error_class",
        "source_surface",
        "input_summary"
      ])
      .where("tool_name", "=", toolName)
      .where("request_id", "=", testRun)
      .execute()
  );
}

describe("module page tool route on the real action table", () => {
  it("T4 runs a confirmed destructive tool once; a replay is refused and records nothing", async () => {
    const id = await ask();
    const first = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: id
    });
    const replay = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: id
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await activityFor(ids.userA, "meals.deletePlan")).toEqual([
      {
        owner_user_id: ids.userA,
        approval_mode: "confirmed",
        outcome: "success",
        error_class: null,
        source_surface: "module_page",
        input_summary: { inputKeys: ["planId"], inputKeyCount: 1, truncated: false }
      }
    ]);
  });

  it("lets exactly one of two racing confirmed calls run", async () => {
    const id = await ask();
    const results = await Promise.all([
      invoke("meals.deletePlan", { input: { planId: "plan-1" }, confirmationId: id }),
      invoke("meals.deletePlan", { input: { planId: "plan-1" }, confirmationId: id })
    ]);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("T5 refuses a confirmation sent with different input", async () => {
    const id = await ask();
    const changed = await invoke("meals.deletePlan", {
      input: { planId: "plan-2" },
      confirmationId: id
    });

    expect(changed.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("refuses a confirmation sent for a different tool of the same module", async () => {
    const id = await ask("meals.deletePlan");
    const other = await invoke("meals.sendList", {
      input: { planId: "plan-1" },
      confirmationId: id
    });

    expect(other.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("T6 refuses another user's confirmation", async () => {
    const id = await ask();
    const stolen = await invoke(
      "meals.deletePlan",
      { input: { planId: "plan-1" }, confirmationId: id },
      "user-b"
    );

    expect(stolen.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
    expect(await activityFor(ids.userB, "meals.deletePlan")).toEqual([]);
  });

  it("T7 refuses a chat request's id even for the same tool", async () => {
    const chatRow = await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      repository.createPendingAssistantAction(scope, {
        toolModuleId: "meals",
        toolModuleName: "Meals",
        toolName: "meals.deletePlan",
        permissionId: "meals.plan",
        risk: "destructive",
        inputSummary: { inputKeys: ["planId"], inputKeyCount: 1, truncated: false },
        chatThreadId: randomUUID(),
        chatSessionId: "chat-fixture",
        expiresAt: new Date(Date.now() + 120_000)
      })
    );
    const response = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: chatRow.id
    });

    expect(response.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("refuses an expired confirmation", async () => {
    // The deadline cannot be shortened after creation, so seed an already-expired page row with
    // the exact digest the route computes for this input.
    const { id } = await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      scope.db
        .insertInto("app.ai_assistant_action_requests")
        .values({
          id: randomUUID(),
          owner_user_id: ids.userA,
          origin: "module_page",
          input_digest: digestToolInput({ planId: "plan-1" }),
          chat_thread_id: null,
          chat_session_id: null,
          expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
          tool_module_id: "meals",
          tool_module_name: "Meals",
          tool_name: "meals.deletePlan",
          permission_id: "meals.plan",
          risk: "destructive",
          status: "pending",
          input_summary: { inputKeys: ["planId"], inputKeyCount: 1, truncated: false },
          request_id: "expired-fixture",
          resolved_at: null
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    );
    const response = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: id
    });

    expect(response.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("Cancel through the existing resolve route stops the outbound tool and records nothing", async () => {
    const id = await ask("meals.sendList");
    const cancel = await api.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${id}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "cancelled" }
    });
    const afterCancel = await invoke("meals.sendList", {
      input: { planId: "plan-1" },
      confirmationId: id
    });

    expect(cancel.statusCode).toBe(200);
    expect(afterCancel.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(0);
    expect(await activityFor(ids.userA, "meals.sendList")).toEqual([]);
  });

  it("records a direct write as auto and a module refusal as failed, never as success", async () => {
    const direct = await invoke("meals.tickLine", { input: { planId: "plan-1" } });
    execute.mockRejectedValueOnce(new ExternalModuleReportedError("meals.locked"));
    const refused = await invoke("meals.tickLine", { input: { planId: "plan-1" } });

    expect(direct.statusCode).toBe(200);
    expect(refused.statusCode).toBe(422);
    const rows = await activityFor(ids.userA, "meals.tickLine");
    expect(rows.map((row) => [row.approval_mode, row.outcome, row.error_class]).sort()).toEqual([
      ["auto", "failed", "module_rejected"],
      ["auto", "success", null]
    ]);
    expect(rows.every((row) => row.source_surface === "module_page")).toBe(true);
  });

  it("a failed confirmed run spends the confirmation", async () => {
    const id = await ask();
    execute.mockRejectedValueOnce(new Error("worker crashed"));
    const failed = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: id
    });
    const retry = await invoke("meals.deletePlan", {
      input: { planId: "plan-1" },
      confirmationId: id
    });

    expect(failed.statusCode).toBe(502);
    expect(retry.json()).toEqual({ code: "confirmation_invalid" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await activityFor(ids.userA, "meals.deletePlan")).map((row) => row.outcome)).toEqual([
      "failed"
    ]);
  });

  it("keeps a user's page activity invisible to another user", async () => {
    await invoke("meals.tickLine", { input: { planId: "plan-1" } });

    expect(await activityFor(ids.userA, "meals.tickLine")).toHaveLength(1);
    expect(await activityFor(ids.userB, "meals.tickLine")).toEqual([]);
  });
});
