import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  AiRepository,
  createModulePageConfirmation,
  consumeModulePageConfirmation,
  type CreateModulePageConfirmationInput
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createApiServer } from "../../apps/api/src/server.js";
import { ActionRequestRecovery } from "../../packages/ai/src/gateway/action-request-recovery.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const input: CreateModulePageConfirmationInput = {
  moduleId: "meals",
  moduleName: "Meals",
  toolName: "meals.deletePlan",
  permissionId: "meals.write",
  risk: "destructive",
  inputSummary: { action: "Delete plan" },
  inputDigest: createHash("sha256").update('{"planId":"example"}').digest(),
  requestId: "module-page-confirmation-test"
};
const owner = { actorUserId: ids.userA };
const repository = new AiRepository();
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let boss: PgBoss;
let server: ReturnType<typeof createApiServer>;

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  runner = new DataContextRunner(db);
  boss = createPgBossClient(connectionStrings.app);
  server = createApiServer({ appDb: db, boss, logger: false });
  await server.ready();
});
afterAll(async () => {
  await server?.close();
  await boss?.stop({ graceful: false });
  await db?.destroy();
});

function createPage() {
  return runner.withDataContext(owner, (scope) => createModulePageConfirmation(scope, input));
}
function consume(
  id: string,
  overrides: Partial<Parameters<typeof consumeModulePageConfirmation>[1]> = {},
  actorUserId: string = ids.userA
) {
  return runner.withDataContext({ actorUserId }, (scope) =>
    consumeModulePageConfirmation(scope, { ...input, id, ...overrides })
  );
}
function readPage(id: string) {
  return runner.withDataContext(owner, (scope) =>
    scope.db
      .selectFrom("app.ai_assistant_action_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  );
}
async function createExpiredPage() {
  // Fixture uses the same runtime role and owner RLS as production. The immutable deadline
  // cannot be shortened after creation, so seed the already-expired state directly.
  return runner.withDataContext(owner, (scope) =>
    scope.db
      .insertInto("app.ai_assistant_action_requests")
      .values({
        id: randomUUID(),
        owner_user_id: ids.userA,
        origin: "module_page",
        input_digest: input.inputDigest,
        chat_thread_id: null,
        chat_session_id: null,
        expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
        tool_module_id: input.moduleId,
        tool_module_name: input.moduleName,
        tool_name: input.toolName,
        permission_id: input.permissionId,
        risk: input.risk,
        status: "pending",
        input_summary: input.inputSummary,
        request_id: input.requestId,
        resolved_at: null
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  );
}

describe("AI-owned module page confirmation persistence", () => {
  it("stores only summary and digest, binds the actor, and sets a two-minute database deadline", async () => {
    const created = await createPage();
    const row = await readPage(created.id);
    expect(created.expiresAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({
      owner_user_id: ids.userA,
      origin: "module_page",
      input_digest: input.inputDigest,
      chat_thread_id: null,
      chat_session_id: null,
      status: "pending",
      resolved_at: null,
      tool_module_id: input.moduleId,
      tool_name: input.toolName,
      input_summary: input.inputSummary
    });
    expect(created.expiresAt.getTime() - row.requested_at.getTime()).toBeGreaterThanOrEqual(
      120_000
    );
    expect(created.expiresAt.getTime() - row.requested_at.getTime()).toBeLessThan(121_000);
  });

  it("atomically consumes once across concurrent actor transactions", async () => {
    const { id } = await createPage();
    expect((await Promise.all([consume(id), consume(id)])).sort()).toEqual([false, true]);
    expect(await consume(id)).toBe(false);
    const row = await readPage(id);
    expect(row.status).toBe("confirmed");
    expect(row.resolved_at).not.toBeNull();
  });

  it("refuses changed input without consuming the original approval", async () => {
    const { id } = await createPage();
    expect(
      await consume(id, { inputDigest: createHash("sha256").update("different plan").digest() })
    ).toBe(false);
    expect((await readPage(id)).status).toBe("pending");
    expect(await consume(id)).toBe(true);
  });

  it("refuses module/tool mismatches and malformed or unknown ids", async () => {
    const { id } = await createPage();
    expect(await consume(id, { moduleId: "other-module" })).toBe(false);
    expect(await consume(id, { toolName: "meals.otherTool" })).toBe(false);
    expect(await consume("not-a-uuid")).toBe(false);
    expect(await consume(randomUUID())).toBe(false);
    expect(await consume(id, { inputDigest: Buffer.alloc(1) })).toBe(false);
    expect(await consume(id)).toBe(true);
  });

  it("keeps other users and admins from reading or consuming an owner's decision", async () => {
    const { id } = await createPage();
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      expect(await consume(id, {}, actorUserId)).toBe(false);
      expect(
        await runner.withDataContext({ actorUserId }, (scope) =>
          repository.getAssistantAction(scope, id)
        )
      ).toBeUndefined();
    }
    expect((await readPage(id)).status).toBe("pending");
    expect(await consume(id)).toBe(true);
  });

  it("never consumes a chat approval as a page approval", async () => {
    const chat = await runner.withDataContext(owner, (scope) =>
      repository.createPendingAssistantAction(scope, {
        toolModuleId: input.moduleId,
        toolModuleName: input.moduleName,
        toolName: input.toolName,
        permissionId: input.permissionId,
        risk: input.risk,
        inputSummary: input.inputSummary,
        chatThreadId: randomUUID(),
        chatSessionId: "chat-fixture",
        expiresAt: new Date(Date.now() + 120_000)
      })
    );
    expect(await consume(chat.id)).toBe(false);
    expect((await readPage(chat.id)).status).toBe("pending");
    expect((await readPage(chat.id)).origin).toBeNull();
  });

  it("refuses expired confirmations and leaves recovery to the existing lifecycle", async () => {
    const { id } = await createExpiredPage();
    expect(await consume(id)).toBe(false);
    expect((await readPage(id)).status).toBe("pending");
    const emit = vi.fn();
    const recovery = new ActionRequestRecovery({ runner, repository, notifier: { emit } });
    try {
      await recovery.recover(ids.userA);
      expect((await readPage(id)).status).toBe("timed_out");
      expect(emit).not.toHaveBeenCalled();
      expect(await consume(id)).toBe(false);
      const confirmed = await createPage();
      expect(await consume(confirmed.id)).toBe(true);
      expect(
        await runner.withDataContext(owner, (scope) =>
          repository.listRecoverableAssistantActions(scope)
        )
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: confirmed.id })]));
    } finally {
      recovery.dispose();
    }
  });

  it("REST cannot approve a page decision without a waiter, but can cancel it", async () => {
    const { id } = await createPage();
    const approve = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${id}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "confirmed" }
    });
    expect(approve.statusCode).toBe(409);
    expect((await readPage(id)).status).toBe("pending");
    const cancel = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-actions/${id}/resolve`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { status: "cancelled" }
    });
    expect(cancel.statusCode).toBe(200);
    expect((await readPage(id)).status).toBe("cancelled");
    expect(await consume(id)).toBe(false);
  });

  it("rejects rewriting page approval identity or digest", async () => {
    const { id } = await createPage();
    for (const patch of [
      { input_digest: Buffer.alloc(32) },
      { origin: null, input_digest: null }
    ]) {
      await expect(
        runner.withDataContext(owner, (scope) =>
          scope.db
            .updateTable("app.ai_assistant_action_requests")
            .set(patch)
            .where("id", "=", id)
            .execute()
        )
      ).rejects.toThrow("Module page confirmation identity cannot be changed");
    }
    expect(await consume(id)).toBe(true);
  });

  it("rejects malformed digests and enforces page/legacy shape on insertion", async () => {
    await expect(
      runner.withDataContext(owner, (scope) =>
        createModulePageConfirmation(scope, { ...input, inputDigest: Buffer.alloc(1) })
      )
    ).rejects.toThrow("Expected a SHA-256 input digest");
    const { id } = await createPage();
    const row = await readPage(id);
    for (const patch of [
      { origin: null },
      { input_digest: null },
      { input_digest: Buffer.alloc(1) },
      { expires_at: null },
      { chat_thread_id: randomUUID() },
      { chat_session_id: "chat" }
    ]) {
      await expect(
        runner.withDataContext(owner, (scope) =>
          scope.db
            .insertInto("app.ai_assistant_action_requests")
            .values({ ...row, ...patch, id: randomUUID() })
            .execute()
        )
      ).rejects.toThrow("ai_assistant_action_page_confirmation_shape");
    }
  });
});
