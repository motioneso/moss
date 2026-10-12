import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, SharesRepository, type MossDatabase } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ListScheduledTasksResponse } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { registerScheduledTaskRoutes } from "../../packages/chat/src/reminders/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let server: FastifyInstance;
let bootstrap: pg.Client;
const chat = new ChatRepository();
const reminders = new ReminderRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(db);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  server = Fastify();
  registerScheduledTaskRoutes(server, {
    dataContext: runner,
    resolveAccessContext: async (request) => {
      const actorUserId = request.headers["x-test-actor"];
      if (typeof actorUserId !== "string") throw new HttpError(401, "Sign in");
      return { actorUserId };
    }
  });
  await server.ready();
});
afterAll(async () => {
  await Promise.allSettled([server?.close(), db?.destroy(), bootstrap?.end()]);
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
    return { ...reminder, threadId: thread.id };
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

describe("read-only Settings reminders", () => {
  it("requires an actor and returns an empty list for a fresh account", async () => {
    expect((await server.inject({ url: "/api/chat/scheduled-tasks" })).statusCode).toBe(401);
    expect(await list(ids.userC)).toEqual({ tasks: [] });
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
  it("reads real delivery/expiration dates and an available exact result without changing storage", async () => {
    const saved = await save(ids.userC, "**recorded result**");
    const reserved = await bootstrap.query<{ reserved_message_id: string }>(
      "SELECT reserved_message_id FROM app.chat_reminders WHERE id = $1",
      [saved.id]
    );
    const messageId = reserved.rows[0]!.reserved_message_id;
    await bootstrap.query(
      `INSERT INTO app.chat_messages (id, thread_id, owner_user_id, role, status, body, model_metadata, tool_metadata)
      VALUES ($1, $2, $3, 'assistant', 'stored', 'Reminder: **recorded result**', '{}', '{}')`,
      [messageId, saved.threadId, ids.userC]
    );
    await bootstrap.query(
      "UPDATE app.chat_reminders SET state = 'delivered', delivered_at = now(), late = false WHERE id = $1",
      [saved.id]
    );
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
});
