import type { PgBoss } from "pg-boss";
import { createPgBossClient } from "@moss/jobs";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, SharesRepository, type MossDatabase } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER } from "@moss/module-sdk/server";
import { createActAsGrantRegistry } from "@moss/auth";
import { createRouteCatalogHolder } from "@moss/module-registry";
import type { ListScheduledTasksResponse } from "@moss/shared";
import { createAppActionsService } from "../../packages/chat/src/app-actions.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { saveQuietHoursAllowance } from "../../packages/chat/src/reminders/quiet-hours-allowances.js";
import { registerScheduledTaskRoutes } from "../../packages/chat/src/reminders/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let server: FastifyInstance;
let bootstrap: pg.Client;
let boss: PgBoss;
const chat = new ChatRepository();
const reminders = new ReminderRepository();
const grants = createActAsGrantRegistry();

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(db);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  server = Fastify();
  registerScheduledTaskRoutes(server, {
    dataContext: runner,
    boss,
    resolveAccessContext: async (request) => {
      const grant = request.headers[ACT_AS_GRANT_HEADER];
      if (typeof grant === "string") {
        const binding = grants.consume(grant);
        if (!binding) throw new HttpError(401, "Sign in");
        return { actorUserId: binding.actorUserId };
      }
      const actorUserId = request.headers["x-test-actor"];
      if (typeof actorUserId !== "string") throw new HttpError(401, "Sign in");
      return { actorUserId };
    }
  });
  await server.ready();
});
afterAll(async () => {
  await Promise.allSettled([
    server?.close(),
    boss?.stop({ graceful: false }),
    db?.destroy(),
    bootstrap?.end()
  ]);
});

async function save(actorUserId: string, text: string) {
  return runner.withDataContext({ actorUserId }, async (scopedDb) => {
    const thread =
      (await chat.getMainThread(scopedDb, actorUserId)) ??
      (await chat.openNewThread(scopedDb, { title: "Main" }));
    const source = await scopedDb.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: thread.id,
        owner_user_id: actorUserId,
        role: "user",
        status: "stored",
        body: `remind me in 10 minutes to ${text}`,
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const reminder = await reminders.create(scopedDb, {
      threadId: thread.id,
      sourceMessageId: source.id,
      when: { timing: "relative", delaySeconds: 600 },
      text
    });
    return { ...reminder, threadId: thread.id, sourceMessageId: source.id };
  });
}
async function list(actorUserId: string): Promise<ListScheduledTasksResponse> {
  const response = await server.inject({
    url: "/api/chat/scheduled-tasks",
    headers: { "x-test-actor": actorUserId }
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListScheduledTasksResponse>();
}

async function deliver(actorUserId: string, instruction: string, body: string) {
  const saved = await save(actorUserId, instruction);
  const reserved = await bootstrap.query<{ reserved_message_id: string }>(
    "SELECT reserved_message_id FROM app.chat_reminders WHERE id = $1",
    [saved.id]
  );
  const messageId = reserved.rows[0]!.reserved_message_id;
  await bootstrap.query(
    `INSERT INTO app.chat_messages (id, thread_id, owner_user_id, role, status, body, model_metadata, tool_metadata)
      VALUES ($1, $2, $3, 'assistant', 'stored', $4, '{}', '{}')`,
    [messageId, saved.threadId, actorUserId, body]
  );
  await bootstrap.query(
    "UPDATE app.chat_reminders SET state = 'delivered', delivered_at = now(), late = false WHERE id = $1",
    [saved.id]
  );
  return { ...saved, messageId };
}

describe("read-only Settings reminders", () => {
  it("requires an actor and returns an empty list for a fresh account", async () => {
    expect((await server.inject({ url: "/api/chat/scheduled-tasks" })).statusCode).toBe(401);
    expect(await list(ids.userC)).toEqual({ tasks: [], approvedScopes: [] });
  });
  it("shows only the owner's records, including all past records", async () => {
    const own = await save(ids.userA, "private stretch");
    const other = await save(ids.userB, "private water");
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      new SharesRepository().grant(scopedDb, {
        resourceType: "chat_thread",
        resourceId: other.threadId,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );
    const tasks = (await list(ids.userA)).tasks;
    expect(tasks.map((task) => task.id)).toEqual([own.id]);
    expect(tasks[0]).toMatchObject({ title: "private stretch", state: "active", runs: [] });
    expect((await list(ids.adminUser)).tasks).toEqual([]);
    // Set up archived records on the disposable gate database, not through a new runtime write API.
    for (let i = 0; i < 12; i++) await save(ids.userA, `past ${i}`);
    await bootstrap.query(
      "UPDATE app.chat_reminders SET state = 'cancelled' WHERE reminder_text LIKE 'past %'"
    );
    expect((await list(ids.userA)).tasks.filter((task) => task.state === "cancelled")).toHaveLength(
      12
    );
  });
  it("keeps the saved message body in the browser response without changing storage", async () => {
    const saved = await deliver(ids.userC, "**recorded result**", "Reminder: **recorded result**");
    const messageId = saved.messageId;
    const before = await bootstrap.query(
      "SELECT state, version, context_state FROM app.chat_reminders WHERE id = $1",
      [saved.id]
    );
    const task = (await list(ids.userC)).tasks[0]!;
    expect(task.state).toBe("completed");
    expect(task.runs[0]?.at).toBeTruthy();
    expect(task.runs[0]?.message).toEqual({
      id: messageId,
      threadId: saved.threadId,
      body: "Reminder: **recorded result**"
    });
    const after = await bootstrap.query(
      "SELECT state, version, context_state FROM app.chat_reminders WHERE id = $1",
      [saved.id]
    );
    expect(after.rows).toEqual(before.rows);
    await bootstrap.query("DELETE FROM app.chat_messages WHERE id = $1", [messageId]);
    expect((await list(ids.userC)).tasks[0]?.runs[0]?.message).toBeNull();
    expect((await list(ids.userB)).tasks.some((entry) => entry.id === saved.id)).toBe(false);
  });
  it("lets Moss read status, timing and history dates without saved message content anywhere", async () => {
    const body = `SCREEN_ONLY_RESULT_${randomUUID()}`;
    const saved = await deliver(ids.userC, "Check the afternoon schedule", body);
    const task = (await list(ids.userC)).tasks.find((entry) => entry.id === saved.id)!;
    expect(task.runs[0]?.message?.body).toBe(body);
    // This transport needs a ready catalog; policy resolution is tested by the app-actions suite.
    const { buildRouteCatalog } = await import("@moss/module-registry");
    const { chatModuleManifest } = await import("../../packages/chat/src/manifest.js");
    const catalog = createRouteCatalogHolder();
    catalog.set(buildRouteCatalog([chatModuleManifest], []));
    const moss = await createAppActionsService({
      server,
      catalog,
      grants,
      readTurnId: () => null
    }).call(
      { method: "GET", path: "/api/chat/scheduled-tasks" },
      { actorUserId: ids.userC, chatSessionId: randomUUID(), requestId: "settings-read" }
    );
    expect(moss.status).toBe(200);
    const tasks = (moss.body as ListScheduledTasksResponse).tasks;
    expect(tasks.find((entry) => entry.id === saved.id)).toEqual({
      ...task,
      runs: [{ ...task.runs[0], message: null }]
    });
    expect(JSON.stringify(moss.body)).not.toContain(body);
  });
});

it("pauses an owner reminder through Settings and keeps earlier messages on deletion", async () => {
  const saved = await save(ids.userA, "Settings controls path");
  const paused = await server.inject({
    method: "POST",
    url: `/api/chat/scheduled-tasks/${saved.id}/pause`,
    headers: { "x-test-actor": ids.userA }
  });
  expect(paused.statusCode).toBe(200);
  expect((await list(ids.userA)).tasks.find((task) => task.id === saved.id)?.state).toBe("paused");
  const resumed = await server.inject({
    method: "POST",
    url: `/api/chat/scheduled-tasks/${saved.id}/resume`,
    headers: { "x-test-actor": ids.userA }
  });
  expect(resumed.statusCode).toBe(200);
  expect((await list(ids.userA)).tasks.find((task) => task.id === saved.id)?.state).toBe("active");
  const denied = await server.inject({
    method: "DELETE",
    url: `/api/chat/scheduled-tasks/${saved.id}`,
    headers: { "x-test-actor": ids.userB }
  });
  expect(denied.statusCode).toBe(404);
  const removed = await server.inject({
    method: "DELETE",
    url: `/api/chat/scheduled-tasks/${saved.id}`,
    headers: { "x-test-actor": ids.userA }
  });
  expect(removed.statusCode).toBe(200);
  expect((await list(ids.userA)).tasks.some((task) => task.id === saved.id)).toBe(false);
  const messages = await runner.withDataContext({ actorUserId: ids.userA }, (db) =>
    chat.listMessages(db, saved.threadId)
  );
  expect(messages.some((row) => row.body.includes("Settings controls path"))).toBe(true);
});

it("never exposes Settings controls to model app-action grants", async () => {
  const saved = await save(ids.userA, "model control boundary");
  const grant = grants.mint({
    actorUserId: ids.userA,
    chatSessionId: randomUUID(),
    turnId: randomUUID()
  });
  const response = await server.inject({
    method: "DELETE",
    url: `/api/chat/scheduled-tasks/${saved.id}`,
    headers: { [ACT_AS_GRANT_HEADER]: grant }
  });
  expect(response.statusCode).toBe(403);
  expect((await list(ids.userA)).tasks.some((task) => task.id === saved.id)).toBe(true);
});

describe("read-only quiet-hours allowance API", () => {
  it("requires sign-in and never exposes a write endpoint", async () => {
    expect((await server.inject({ url: "/api/chat/quiet-hours-allowances" })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/chat/quiet-hours-allowances",
          headers: { "x-test-actor": ids.userA }
        })
      ).statusCode
    ).toBe(404);
  });
  it("lists only saved owner allowances, uses Main as the chat destination and reflects removal", async () => {
    const own = await save(ids.userC, "private allowed reminder");
    const other = await save(ids.userD, "other owner reminder");
    for (const [actorUserId, saved] of [
      [ids.userC, own],
      [ids.userD, other]
    ] as const) {
      await runner.withDataContext({ actorUserId }, (scoped) =>
        saveQuietHoursAllowance(scoped, saved.id, true, saved.sourceMessageId)
      );
    }
    const listAllowed = (actorUserId: string) =>
      server.inject({
        url: "/api/chat/quiet-hours-allowances",
        headers: { "x-test-actor": actorUserId }
      });
    const response = await listAllowed(ids.userC);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mainThreadId: own.threadId,
      allowances: [{ id: own.id, title: "private allowed reminder" }]
    });
    expect((await listAllowed(ids.adminUser)).json().allowances).toEqual([]);
    expect(response.body).not.toContain("source_message_id");
    expect(response.body).not.toContain("other owner reminder");
    await runner.withDataContext({ actorUserId: ids.userC }, (scoped) =>
      saveQuietHoursAllowance(scoped, own.id, false, own.sourceMessageId)
    );
    expect((await listAllowed(ids.userC)).json().allowances).toEqual([]);
  });
});
