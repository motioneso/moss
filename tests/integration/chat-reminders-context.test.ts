import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";

import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3311: the next Main model turn reads the delivered reminders whose context is pending, and the
// stored turn acknowledges exactly the ones it was shown. Acknowledged reminders leave the cap.

const { Client } = pg;

const chat = new ChatRepository();
const EXECUTED = { provider: "anthropic", model: "test-model" } as const;

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let bootstrap: pg.Client;
let persistence: DataContextChatPersistence;

type Reminder = { id: string; threadId: string; reservedMessageId: string; owner: string };

function asOwner<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return app.withDataContext({ actorUserId }, work);
}

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

async function sideThreadId(actorUserId: string): Promise<string> {
  await mainThreadId(actorUserId);
  return asOwner(actorUserId, async (db) => (await chat.openNewThread(db, { title: "Side" })).id);
}

async function queueReminder(actorUserId: string): Promise<Reminder> {
  const threadId = await mainThreadId(actorUserId);
  return asOwner(actorUserId, async (db) => {
    const source = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_user_id: actorUserId,
        role: "user",
        status: "stored",
        body: "remind me in 1 minute to stretch",
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = await db.db
      .insertInto("app.chat_reminders")
      .values({
        id: randomUUID(),
        owner_user_id: actorUserId,
        thread_id: threadId,
        source_message_id: source.id,
        reserved_message_id: randomUUID(),
        reminder_text: "stretch",
        delay_seconds: 60
      })
      .returning(["id", "reserved_message_id"])
      .executeTakeFirstOrThrow();
    return { id: row.id, threadId, reservedMessageId: row.reserved_message_id, owner: actorUserId };
  });
}

async function deliver(reminder: Reminder, body: string, deliveredAt = new Date()): Promise<void> {
  await worker.withDataContext({ actorUserId: reminder.owner }, async (db) => {
    await db.db
      .insertInto("app.chat_messages")
      .values({
        id: reminder.reservedMessageId,
        thread_id: reminder.threadId,
        owner_user_id: reminder.owner,
        role: "assistant",
        status: "stored",
        body,
        model_metadata: {},
        tool_metadata: {}
      })
      .execute();
    await db.db
      .updateTable("app.chat_reminders")
      .set({ state: "delivered", delivered_at: deliveredAt, late: false })
      .where("id", "=", reminder.id)
      .execute();
  });
}

async function deliveredReminder(actorUserId: string, body: string, at?: Date) {
  const reminder = await queueReminder(actorUserId);
  await deliver(reminder, body, at);
  return reminder;
}

// Planting skips triggers for its own session only, so a delivered reminder can sit past the
// insert cap or in a side chat, where the app never creates one.
async function plantDelivered(
  actorUserId: string,
  threadId: string,
  deliveredAt: Date
): Promise<Reminder> {
  const id = randomUUID();
  const sourceId = randomUUID();
  const reservedId = randomUUID();
  await bootstrap.query("SET session_replication_role = replica");
  try {
    await bootstrap.query(
      `INSERT INTO app.chat_messages
         (id, thread_id, owner_user_id, role, status, body, model_metadata, tool_metadata)
       VALUES ($1, $3, $4, 'user', 'stored', 'remind me', '{}', '{}'),
              ($2, $3, $4, 'assistant', 'stored', 'Reminder: beyond cap', '{}', '{}')`,
      [sourceId, reservedId, threadId, actorUserId]
    );
    await bootstrap.query(
      `INSERT INTO app.chat_reminders
         (id, owner_user_id, thread_id, source_message_id, reserved_message_id, reminder_text,
          delay_seconds, due_at, state, delivered_at, late)
       VALUES ($1, $2, $3, $4, $5, 'beyond cap', 60, $6, 'delivered', $6, false)`,
      [id, actorUserId, threadId, sourceId, reservedId, deliveredAt]
    );
  } finally {
    await bootstrap.query("SET session_replication_role = DEFAULT");
  }
  return { id, threadId, reservedMessageId: reservedId, owner: actorUserId };
}

async function deliveredBeyondCap(actorUserId: string, deliveredAt: Date): Promise<string> {
  const threadId = await mainThreadId(actorUserId);
  return (await plantDelivered(actorUserId, threadId, deliveredAt)).reservedMessageId;
}

async function contextStates(actorUserId: string): Promise<Record<string, string>> {
  const result = await bootstrap.query<{ reserved_message_id: string; context_state: string }>(
    "SELECT reserved_message_id, context_state FROM app.chat_reminders WHERE owner_user_id = $1",
    [actorUserId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.reserved_message_id, row.context_state]));
}

function acknowledgeAs(
  runner: DataContextRunner,
  actorUserId: string,
  reminder: Reminder
): Promise<bigint> {
  return runner.withDataContext({ actorUserId }, async (db) => {
    const result = await db.db
      .updateTable("app.chat_reminders")
      .set({ context_state: "acknowledged" })
      .where("id", "=", reminder.id)
      .executeTakeFirst();
    return result.numUpdatedRows;
  });
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  persistence = new DataContextChatPersistence({
    dataContext: app,
    chatRepository: chat,
    aiRepository: new AiRepository()
  });
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});

afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), workerDb?.destroy(), bootstrap?.end()]);
});

beforeEach(async () => {
  await bootstrap.query("DELETE FROM app.chat_reminders");
});

describe("reading pending Main reminders (#3311)", () => {
  it("lists only delivered pending reminders in the actor's Main chat, oldest first", async () => {
    const later = await deliveredReminder(ids.userA, "Reminder: later", new Date(2_000_000));
    const earlier = await deliveredReminder(ids.userA, "Reminder: earlier", new Date(1_000_000));
    await queueReminder(ids.userA);
    const threadId = await mainThreadId(ids.userA);

    expect(await persistence.listPendingMainReminders(ids.userA, threadId)).toEqual([
      { reservedMessageId: earlier.reservedMessageId, body: "Reminder: earlier" },
      { reservedMessageId: later.reservedMessageId, body: "Reminder: later" }
    ]);
  });

  it("caps the batch at the 20 oldest", async () => {
    for (let index = 0; index < 20; index += 1) {
      await deliveredReminder(ids.userA, `Reminder ${index}`, new Date(1_000_000 + index));
    }
    const newest = await deliveredBeyondCap(ids.userA, new Date(2_000_000));
    const threadId = await mainThreadId(ids.userA);

    const batch = await persistence.listPendingMainReminders(ids.userA, threadId);
    expect(batch).toHaveLength(20);
    expect(batch[0]!.body).toBe("Reminder 0");
    expect(batch.map((row) => row.reservedMessageId)).not.toContain(newest);
  });

  it("shows nothing to a side chat or to another user", async () => {
    await deliveredReminder(ids.userA, "Reminder: private");
    const side = await sideThreadId(ids.userA);
    const main = await mainThreadId(ids.userA);

    expect(await persistence.listPendingMainReminders(ids.userA, side)).toEqual([]);
    expect(await persistence.listPendingMainReminders(ids.userB, main)).toEqual([]);
  });
});

describe("acknowledging shown reminders (#3311)", () => {
  it("acknowledges exactly the shown ids when the model turn is stored", async () => {
    const shown = await deliveredReminder(ids.userA, "Reminder: shown");
    const arrivedLater = await deliveredReminder(ids.userA, "Reminder: arrived later");
    const threadId = await mainThreadId(ids.userA);

    const stored = await persistence.recordTurn(
      ids.userA,
      "what next?",
      "Stretch first.",
      EXECUTED,
      {
        threadId,
        acknowledgeReminderMessageIds: [shown.reservedMessageId]
      }
    );

    expect(stored).toBeDefined();
    expect(await contextStates(ids.userA)).toEqual({
      [shown.reservedMessageId]: "acknowledged",
      [arrivedLater.reservedMessageId]: "pending"
    });
    expect(await persistence.listPendingMainReminders(ids.userA, threadId)).toEqual([
      { reservedMessageId: arrivedLater.reservedMessageId, body: "Reminder: arrived later" }
    ]);
  });

  it("acknowledges nothing from a turn stored in a side chat", async () => {
    const shown = await deliveredReminder(ids.userA, "Reminder: shown");
    const side = await sideThreadId(ids.userA);

    await persistence.recordTurn(ids.userA, "hi", "hello", EXECUTED, {
      threadId: side,
      acknowledgeReminderMessageIds: [shown.reservedMessageId]
    });

    expect(await contextStates(ids.userA)).toEqual({ [shown.reservedMessageId]: "pending" });
  });

  it("frees a capacity slot once acknowledged", async () => {
    const saved: Reminder[] = [];
    for (let index = 0; index < 20; index += 1) {
      saved.push(await deliveredReminder(ids.userA, `Reminder ${index}`));
    }
    await expect(queueReminder(ids.userA)).rejects.toThrow(/chat_reminder_capacity_reached/);

    expect(await acknowledgeAs(app, ids.userA, saved[0]!)).toBe(1n);
    await expect(queueReminder(ids.userA)).resolves.toMatchObject({ owner: ids.userA });
  });
});

describe("who may acknowledge, and how (#3311)", () => {
  it("lets no other user and not the worker acknowledge a reminder", async () => {
    const reminder = await deliveredReminder(ids.userA, "Reminder: mine");

    expect(await acknowledgeAs(app, ids.userB, reminder)).toBe(0n);
    expect(await acknowledgeAs(worker, ids.userA, reminder)).toBe(0n);
    expect(await contextStates(ids.userA)).toEqual({ [reminder.reservedMessageId]: "pending" });
  });

  it("never acknowledges a reminder outside the Main chat", async () => {
    const side = await sideThreadId(ids.userA);
    const planted = await plantDelivered(ids.userA, side, new Date());
    await expect(acknowledgeAs(app, ids.userA, planted)).rejects.toThrow(/row-level security/);
    expect(await contextStates(ids.userA)).toEqual({ [planted.reservedMessageId]: "pending" });
  });

  it("never acknowledges a queued reminder", async () => {
    const queued = await queueReminder(ids.userA);
    await expect(acknowledgeAs(app, ids.userA, queued)).rejects.toThrow(
      /identity cannot be changed/
    );
  });

  it("never acknowledges a reminder twice", async () => {
    const delivered = await deliveredReminder(ids.userA, "Reminder: once");
    expect(await acknowledgeAs(app, ids.userA, delivered)).toBe(1n);
    await expect(acknowledgeAs(app, ids.userA, delivered)).rejects.toThrow(
      /acknowledged once after delivery/
    );
  });

  it("never lets an acknowledgement change the reminder itself", async () => {
    const reminder = await deliveredReminder(ids.userA, "Reminder: fixed");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ reminder_text: "Reminder: changed", context_state: "acknowledged" })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects every context change except delivered pending to acknowledged", async () => {
    const queued = await queueReminder(ids.userA);
    await expect(
      bootstrap.query(
        "UPDATE app.chat_reminders SET context_state = 'acknowledged' WHERE id = $1",
        [queued.id]
      )
    ).rejects.toThrow(/identity cannot be changed/);

    const delivered = await deliveredReminder(ids.userA, "Reminder: one way");
    await expect(
      bootstrap.query(
        "UPDATE app.chat_reminders SET context_state = 'acknowledged', late = true WHERE id = $1",
        [delivered.id]
      )
    ).rejects.toThrow(/acknowledged once after delivery/);
    await bootstrap.query(
      "UPDATE app.chat_reminders SET context_state = 'acknowledged' WHERE id = $1",
      [delivered.id]
    );
    await expect(
      bootstrap.query("UPDATE app.chat_reminders SET context_state = 'pending' WHERE id = $1", [
        delivered.id
      ])
    ).rejects.toThrow(/acknowledged once after delivery/);
    await expect(
      bootstrap.query("UPDATE app.chat_reminders SET context_state = 'dismissed' WHERE id = $1", [
        delivered.id
      ])
    ).rejects.toThrow(/acknowledged once after delivery/);

    const dismissed = await deliveredReminder(ids.userA, "Reminder: dismissed first");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET context_state = 'dismissed' WHERE id = $1",
      [dismissed.id]
    );
    await expect(
      bootstrap.query(
        "UPDATE app.chat_reminders SET context_state = 'acknowledged' WHERE id = $1",
        [dismissed.id]
      )
    ).rejects.toThrow(/acknowledged once after delivery/);
  });
});
