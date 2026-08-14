import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { AiRepository } from "@moss/ai";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #1256: the ai module's own resolve route must honor the same live-confirmation-waiter gate as
// chat's resolve route, instead of persisting a decision straight through the repository — a stale
// pending row with no live waiter must not be flippable to confirmed via the ai route either.
describe("assistant action resolve parity", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: AiRepository;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 }); // #1124: CI PG connect can exceed pg-boss's 10s default even on success (test-only)
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  async function seedPendingAction(): Promise<string> {
    const action = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createPendingAssistantAction(scopedDb, {
        toolModuleId: "tasks",
        toolModuleName: "Tasks",
        toolName: "tasks.updateStatus",
        permissionId: "tasks.update",
        risk: "write",
        inputSummary: { taskId: "resolve-parity-test" }
      })
    );
    return action.id;
  }

  it("both routes reject confirm with no live waiter (409, row stays pending)", async () => {
    const aiActionId = await seedPendingAction();
    const chatActionId = await seedPendingAction();

    const aiRes = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${aiActionId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "confirmed" }
    });
    const chatRes = await server.inject({
      method: "POST",
      url: `/api/chat/action-requests/${chatActionId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "confirmed" }
    });

    expect(aiRes.statusCode).toBe(409);
    expect(chatRes.statusCode).toBe(409);

    const [aiRow, chatRow] = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      Promise.all([
        repository.getAssistantAction(scopedDb, aiActionId),
        repository.getAssistantAction(scopedDb, chatActionId)
      ])
    );
    expect(aiRow?.status).toBe("pending");
    expect(chatRow?.status).toBe("pending");
  });

  it("both routes 404 an unknown action id", async () => {
    // #1591 fixed the "confirmed" short-circuit to 409 (expired) before an existence check ever
    // ran; reject/cancel remain the simplest case to assert here since they never touched the
    // live-waiter gate in the first place.
    const unknownId = "62000000-0000-4000-8000-0000000000ff";

    const aiRes = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${unknownId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "rejected" }
    });
    const chatRes = await server.inject({
      method: "POST",
      url: `/api/chat/action-requests/${unknownId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "rejected" }
    });

    expect(aiRes.statusCode).toBe(404);
    expect(chatRes.statusCode).toBe(404);
  });

  it("both routes now 404 an unknown action id with status=confirmed too (#1591)", async () => {
    // Previously unreachable: "confirmed" short-circuited to 409 (expired) before an existence
    // check ever ran. #1591 added an owner-scoped existence pre-check, so confirmed + no such row
    // now takes the same not-found path as reject/cancel.
    const unknownId = "62000000-0000-4000-8000-0000000000ff";

    const aiRes = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${unknownId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "confirmed" }
    });
    const chatRes = await server.inject({
      method: "POST",
      url: `/api/chat/action-requests/${unknownId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "confirmed" }
    });

    expect(aiRes.statusCode).toBe(404);
    expect(chatRes.statusCode).toBe(404);
  });

  it("ai route resolves a reject with no live waiter (terminal decisions don't need one)", async () => {
    const actionId = await seedPendingAction();

    const aiRes = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${actionId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "rejected" }
    });

    expect(aiRes.statusCode).toBe(200);
    expect(aiRes.json<{ action: { status: string } }>().action.status).toBe("rejected");

    const row = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getAssistantAction(scopedDb, actionId)
    );
    expect(row?.status).toBe("rejected");
  });

  // #1256 N2: gateway.ts's resolveActionRequest only unblocks the live waiter when the repository
  // update actually matched a row (owner + still pending) — a guessed id belonging to another user
  // must not resolve on either route, and the row must stay untouched.
  it("both routes reject another user's action id (404, row stays pending)", async () => {
    const aiActionId = await seedPendingAction();
    const chatActionId = await seedPendingAction();

    const aiRes = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${aiActionId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { status: "rejected" }
    });
    const chatRes = await server.inject({
      method: "POST",
      url: `/api/chat/action-requests/${chatActionId}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { status: "rejected" }
    });

    expect(aiRes.statusCode).toBe(404);
    expect(chatRes.statusCode).toBe(404);

    const [aiRow, chatRow] = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      Promise.all([
        repository.getAssistantAction(scopedDb, aiActionId),
        repository.getAssistantAction(scopedDb, chatActionId)
      ])
    );
    expect(aiRow?.status).toBe("pending");
    expect(chatRow?.status).toBe("pending");
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-ai"
  };
}
