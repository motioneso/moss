import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { AiRepository } from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("assistant action resolution without a wired gateway", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let externalModulesDir: string;

  beforeAll(async () => {
    await resetFoundationDatabase();
    externalModulesDir = mkdtempSync(join(tmpdir(), "unwired-action-resolve-"));
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false,
      apiServerConfig: {
        host: "127.0.0.1",
        port: 0,
        mcpServerUrl: "",
        externalModulesDir
      },
      // These wiring-only routes are deliberately absent in the unwired topology. Register inert
      // placeholders so the full server's manifest-coverage assertion can still validate the tree.
      __testExtraGuardedRoutes: {
        manifests: [],
        routes: [
          { method: "POST", url: "/api/chat/action-requests/:id/resolve" },
          { method: "POST", url: "/api/mcp" },
          { method: "POST", url: "/internal/permission" }
        ]
      }
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    if (externalModulesDir) rmSync(externalModulesDir, { recursive: true, force: true });
  });

  it("lets an owner reject a pending action", async () => {
    const actionId = await seedPendingAction();

    const response = await resolveAction(actionId, "rejected", ids.sessionA);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ action: { status: string } }>().action.status).toBe("rejected");
    expect((await getActionAsOwner(actionId))?.status).toBe("rejected");
  });

  it("lets an owner cancel a pending action", async () => {
    const actionId = await seedPendingAction();

    const response = await resolveAction(actionId, "cancelled", ids.sessionA);

    expect(response.statusCode).toBe(200);
    expect((await getActionAsOwner(actionId))?.status).toBe("cancelled");
  });

  it("fails closed when an owner confirms a pending action", async () => {
    const actionId = await seedPendingAction();

    const response = await resolveAction(actionId, "confirmed", ids.sessionA);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Assistant action resolution is not available" });
    const action = await getActionAsOwner(actionId);
    expect(action?.status).toBe("pending");
    expect(action?.resolved_at).toBeNull();
  });

  it("does not let another user reject an owner's pending action", async () => {
    const actionId = await seedPendingAction();

    const response = await resolveAction(actionId, "rejected", ids.sessionB);

    expect(response.statusCode).toBe(404);
    expect((await getActionAsOwner(actionId))?.status).toBe("pending");
  });

  it("returns not found when an owner rejects an unknown action", async () => {
    const response = await resolveAction(
      "62000000-0000-4000-8000-0000000000ff",
      "rejected",
      ids.sessionA
    );

    expect(response.statusCode).toBe(404);
  });

  it("does not resolve an already terminal action again", async () => {
    const actionId = await seedPendingAction();
    expect((await resolveAction(actionId, "rejected", ids.sessionA)).statusCode).toBe(200);

    const response = await resolveAction(actionId, "rejected", ids.sessionA);

    expect(response.statusCode).toBe(404);
    expect((await getActionAsOwner(actionId))?.status).toBe("rejected");
  });

  it("validates the status before resolving an action", async () => {
    const actionId = await seedPendingAction();

    const response = await resolveAction(actionId, "executed", ids.sessionA);

    expect(response.statusCode).toBe(400);
    expect((await getActionAsOwner(actionId))?.status).toBe("pending");
  });

  async function seedPendingAction(): Promise<string> {
    const action = await dataContext.withDataContext(ownerContext(), (scopedDb) =>
      repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: "tasks",
        toolModuleName: "Tasks",
        toolName: "tasks.updateStatus",
        permissionId: "tasks.update",
        risk: "write",
        inputSummary: { taskId: "unwired-resolve-test" }
      })
    );
    return action.id;
  }

  function resolveAction(actionId: string, status: string, sessionId: string) {
    return server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${actionId}/resolve`,
      headers: { authorization: `Bearer ${sessionId}` },
      payload: { status }
    });
  }

  function getActionAsOwner(actionId: string) {
    return dataContext.withDataContext(ownerContext(), (scopedDb) =>
      repository.getAssistantAction(scopedDb, actionId)
    );
  }
});

function ownerContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:user-a-unwired-resolve" };
}
