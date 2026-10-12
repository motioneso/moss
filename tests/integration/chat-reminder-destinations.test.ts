import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { resolveReminderDestination } from "../../packages/chat/src/reminders/destination.js";
import { decideReminderTurn } from "../../packages/chat/src/reminders/turn.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { deliverDueReminder } from "../../packages/chat/src/reminders/deliver.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const chat = new ChatRepository();
const reminders = new ReminderRepository();
const boss = { send: vi.fn(async () => randomUUID()) };
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let bootstrap: pg.Client;
beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});
afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), workerDb?.destroy(), bootstrap?.end()]);
});
const owner = <T>(work: (db: DataContextDb) => Promise<T>, actorUserId: string = ids.userA) =>
  app.withDataContext({ actorUserId }, work);
async function side(title: string, actorUserId: string = ids.userA, incognito = false) {
  return owner(async (db) => {
    if (!(await chat.getMainThread(db, actorUserId)))
      await chat.openNewThread(db, { title: "Main" });
    return chat.openNewThread(db, { title, incognito });
  }, actorUserId);
}
async function save(sourceThreadId: string, destination?: string, actorUserId: string = ids.userA) {
  return owner(async (db) => {
    const thread = (await chat.getOwnedThreadById(db, actorUserId, sourceThreadId))!;
    const decision = await decideReminderTurn(
      db,
      {
        reminders,
        boss,
        locale: async () => ({ timeZone: "UTC", clockFormat: "24" })
      },
      actorUserId,
      thread,
      {
        kind: "request",
        text: "destination proof",
        delaySeconds: 60,
        ...(destination ? { destination } : {})
      }
    );
    expect(decision.origin.event).toBe("saved");
    const source = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: thread.id,
        owner_user_id: actorUserId,
        role: "user",
        status: "stored",
        body: "remind me in 1 minute to destination proof",
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await decision.save!(source.id);
    return db.db
      .selectFrom("app.chat_reminders")
      .selectAll()
      .where("id", "=", decision.origin.reminderId!)
      .executeTakeFirstOrThrow();
  }, actorUserId);
}
async function due(id: string) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = now() - interval '1 second' WHERE id = $1",
      [id]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}
function deliver(id: string, version: number, actorUserId: string = ids.userA) {
  return worker.withDataContext({ actorUserId }, (db) =>
    deliverDueReminder(db, { resourceId: id, version, actorUserId }, { chat, reminders })
  );
}

describe("owned task destinations", () => {
  it("defaults to Main from a side chat and persists explicit side results once", async () => {
    const source = await side("Travel");
    const defaultTask = await save(source.id);
    const explicit = await save(source.id, "this chat");
    expect(defaultTask.thread_id).not.toBe(source.id);
    expect(defaultTask.destination_title).toBeNull();
    expect(explicit.thread_id).toBe(source.id);
    expect(explicit.destination_title).toBe("Travel");
    await due(explicit.id);
    expect(await deliver(explicit.id, explicit.version)).toBe("delivered");
    expect(await deliver(explicit.id, explicit.version)).toBe("already_delivered");
    const message = await owner((db) => chat.getMessageById(db, explicit.reserved_message_id));
    expect(message?.thread_id).toBe(source.id);
    expect(message?.body).toBe("Reminder: destination proof");
  });
  it("destination-only edits preserve time/text and invalidate the old queued version", async () => {
    const source = await side("Route source");
    const target = await side("Route target");
    const saved = await save(source.id);
    const result = await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        saved.version,
        {
          text: null,
          delaySeconds: null,
          localDue: null,
          deadline: "keep",
          localDeadline: null,
          destination: "Route target"
        },
        "UTC",
        source.id
      )
    );
    expect(result.kind).toBe("changed");
    const changed = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(changed.thread_id).toBe(target.id);
    expect(changed.version).toBe(saved.version + 1);
    expect(changed.due_at).toEqual(saved.due_at);
    expect(changed.reminder_text).toBe(saved.reminder_text);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("stale_version");
    expect(await deliver(saved.id, changed.version)).toBe("delivered");
  });
  it("keeps destination edits paused and acknowledges only the exact delivered side chat", async () => {
    const source = await side("Paused source");
    const target = await side("Paused target");
    const saved = await save(source.id);
    await owner((db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "paused", version: saved.version + 1 })
        .where("id", "=", saved.id)
        .execute()
    );
    const beforeJobs = boss.send.mock.calls.length;
    const edited = await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        saved.version + 1,
        {
          text: null,
          delaySeconds: null,
          localDue: null,
          deadline: "keep",
          localDeadline: null,
          destination: "Paused target"
        },
        "UTC",
        source.id
      )
    );
    expect(edited.kind).toBe("changed");
    expect(boss.send.mock.calls.length).toBe(beforeJobs);
    expect(await deliver(saved.id, saved.version + 2)).toBe("paused");
    const delivered = await save(target.id, "this chat");
    await due(delivered.id);
    expect(await deliver(delivered.id, delivered.version)).toBe("delivered");
    expect(await owner((db) => reminders.listPendingMain(db, source.id, 20))).toEqual([]);
    const pending = await owner((db) => reminders.listPendingMain(db, target.id, 20));
    expect(pending.map((row) => row.reservedMessageId)).toContain(delivered.reserved_message_id);
    await owner((db) => reminders.acknowledgeMain(db, source.id, [delivered.reserved_message_id]));
    expect(await owner((db) => reminders.listPendingMain(db, target.id, 20))).toEqual(pending);
    await owner((db) => reminders.acknowledgeMain(db, target.id, [delivered.reserved_message_id]));
    expect(await owner((db) => reminders.listPendingMain(db, target.id, 20))).toEqual([]);
  });
  it("fails delivery if the destination stops belonging to its owner", async () => {
    const target = await side("Ownership changed");
    const saved = await save(target.id, "this chat");
    await bootstrap.query("UPDATE app.chat_threads SET owner_user_id = $1 WHERE id = $2", [
      ids.userB,
      target.id
    ]);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("destination_unavailable");
    expect(await owner((db) => chat.getMessageById(db, saved.reserved_message_id))).toBeUndefined();
    expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe("failed");
  });
  it("refuses foreign, private, missing and ambiguous names", async () => {
    await side("Foreign only", ids.userB);
    await side("Private only", ids.userA, true);
    await side("Duplicate name");
    await side("Duplicate name");
    for (const name of ["Foreign only", "Private only", "Missing name", "Duplicate name"]) {
      expect(await owner((db) => resolveReminderDestination(db, ids.userA, name))).toHaveProperty(
        "reply"
      );
    }
  });
  it("the worker policy binds the reserved result to its destination (mutation check)", async () => {
    const target = await side("Policy target");
    const wrong = await side("Policy wrong thread");
    const saved = await save(target.id, "this chat");
    const insert = () =>
      worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        chat.insertReservedAssistantMessage(db, {
          id: saved.reserved_message_id,
          threadId: wrong.id,
          body: "wrong destination",
          origin: {
            version: 1,
            kind: "reminder",
            event: "delivered",
            reminderId: saved.id,
            late: false
          },
          now: new Date()
        })
      );
    await expect(insert()).rejects.toMatchObject({ code: "42501" });
    const policy = await bootstrap.query(
      "SELECT pg_get_expr(polwithcheck, polrelid) AS predicate FROM pg_policy WHERE polrelid = 'app.chat_messages'::regclass AND polname = 'chat_messages_insert_reminder'"
    );
    const predicate = policy.rows[0]!.predicate as string;
    try {
      await bootstrap.query(
        "ALTER POLICY chat_messages_insert_reminder ON app.chat_messages WITH CHECK (true)"
      );
      await expect(insert()).resolves.toBeUndefined();
    } finally {
      await bootstrap.query(
        `ALTER POLICY chat_messages_insert_reminder ON app.chat_messages WITH CHECK (${predicate})`
      );
      await bootstrap.query("DELETE FROM app.chat_messages WHERE id = $1", [
        saved.reserved_message_id
      ]);
    }
    await expect(insert()).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps a missing destination visible as failed instead of silently posting to Main", async () => {
    const target = await side("Gone target");
    const saved = await save(target.id, "this chat");
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("destination_unavailable");
    const row = await owner((db) => reminders.readState(db, saved.id));
    expect(row?.state).toBe("failed");
    expect(await owner((db) => chat.getMessageById(db, saved.reserved_message_id))).toBeUndefined();
  });
  it("account deletion removes reminders even after their destination was deleted", async () => {
    const actor = randomUUID();
    await bootstrap.query("INSERT INTO app.users (id, email) VALUES ($1, $2)", [
      actor,
      `${actor}@example.test`
    ]);
    const live = await side("Account live", actor);
    const gone = await side("Account gone", actor);
    const first = await save(live.id, "this chat", actor);
    const second = await save(gone.id, "this chat", actor);
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [gone.id]);
    const before = await bootstrap.query(
      "SELECT id FROM app.chat_reminders WHERE owner_user_id = $1",
      [actor]
    );
    expect(before.rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    const fk = await bootstrap.query(
      "SELECT confdeltype FROM pg_constraint WHERE conrelid = 'app.chat_reminders'::regclass AND conname = 'chat_reminders_owner_user_id_fkey'"
    );
    expect(fk.rows[0]?.confdeltype).toBe("c");
    await bootstrap.query("DELETE FROM app.users WHERE id = $1", [actor]);
    const after = await bootstrap.query(
      "SELECT id FROM app.chat_reminders WHERE owner_user_id = $1",
      [actor]
    );
    expect(after.rows).toEqual([]);
  });
});
