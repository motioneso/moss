// #3195: a delivered reminder is heard by the API only after its delivery commits, carries ids
// only, and is shown only after the owner's own re-read finds a stored Main reminder.

import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";

import type { MainBackgroundMessage } from "../../packages/chat/src/live/background-message-routing.js";
import { deliverDueReminder } from "../../packages/chat/src/reminders/deliver.js";
import {
  readReminderArrival,
  REMINDER_ARRIVAL_CHANNEL,
  startReminderArrivalListener,
  type ReminderArrival
} from "../../packages/chat/src/reminders/live-arrival.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const chat = new ChatRepository();
const reminders = new ReminderRepository();
const deps = { chat, reminders };
const SENTINEL = "sentinel";

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let bootstrap: pg.Client;
let listener: pg.Client;
let heard: string[] = [];

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  listener = new Client({ connectionString: connectionStrings.app });
  await Promise.all([bootstrap.connect(), listener.connect()]);
  listener.on("notification", (notification) => {
    if (notification.channel === REMINDER_ARRIVAL_CHANNEL) heard.push(notification.payload ?? "");
  });
  await listener.query(`LISTEN ${REMINDER_ARRIVAL_CHANNEL}`);
});

afterAll(async () => {
  await Promise.allSettled([
    appDb?.destroy(),
    workerDb?.destroy(),
    bootstrap?.end(),
    listener?.end()
  ]);
});

beforeEach(() => {
  heard = [];
});

/**
 * Notifications from committed transactions arrive in commit order, so once a later sentinel
 * is heard every earlier delivery's notification has been heard too.
 */
async function heardBefore(): Promise<string[]> {
  await bootstrap.query(`SELECT pg_notify($1, $2)`, [REMINDER_ARRIVAL_CHANNEL, SENTINEL]);
  await vi.waitFor(() => expect(heard).toContain(SENTINEL));
  return heard.filter((payload) => payload !== SENTINEL);
}

function asOwner<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return app.withDataContext({ actorUserId }, work);
}

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

async function insertMessage(
  actorUserId: string,
  threadId: string,
  role: "user" | "assistant",
  body: string
): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const row = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_user_id: actorUserId,
        role,
        status: "stored",
        body,
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

interface DueSaved {
  readonly id: string;
  readonly version: number;
  readonly threadId: string;
  readonly reservedMessageId: string;
}

/** Saves a reminder that is already due. Triggers are off so the stored time can change. */
async function saveDue(actorUserId: string = ids.userA, text = "stretch"): Promise<DueSaved> {
  const threadId = await mainThreadId(actorUserId);
  const sourceMessageId = await insertMessage(
    actorUserId,
    threadId,
    "user",
    `remind me in 1 minute to ${text}`
  );
  const saved = await asOwner(actorUserId, (db) =>
    reminders.create(db, { threadId, sourceMessageId, delaySeconds: 60, text })
  );
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    const updated = await bootstrap.query<{ reserved_message_id: string }>(
      `UPDATE app.chat_reminders SET due_at = now() - interval '30 seconds' WHERE id = $1
       RETURNING reserved_message_id`,
      [saved.id]
    );
    await bootstrap.query("COMMIT");
    const reservedMessageId = updated.rows[0]!.reserved_message_id;
    return { id: saved.id, version: saved.version, threadId, reservedMessageId };
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}

function deliver(saved: DueSaved, actorUserId: string = ids.userA) {
  return worker.withDataContext({ actorUserId }, (db) =>
    deliverDueReminder(db, { actorUserId, resourceId: saved.id, version: saved.version }, deps)
  );
}

function arrivalOf(saved: DueSaved, actorUserId: string = ids.userA): ReminderArrival {
  return { actorUserId, threadId: saved.threadId, messageId: saved.reservedMessageId };
}

describe("the delivery worker's notification", () => {
  it("is sent once a delivery commits, and carries only the three ids", async () => {
    const saved = await saveDue(ids.userA, "drink water");
    await expect(deliver(saved)).resolves.toBe("delivered");

    const payloads = await heardBefore();
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0]!)).toEqual(arrivalOf(saved));
    expect(payloads[0]).not.toContain("drink water");
  });

  it("is not sent when the delivery transaction rolls back", async () => {
    const saved = await saveDue();
    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, async (db) => {
        await deliverDueReminder(
          db,
          { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
          deps
        );
        throw new Error("roll back");
      })
    ).rejects.toThrow("roll back");

    expect(await heardBefore()).toEqual([]);
  });

  it("is not sent when the last attempt rolls back to its savepoint", async () => {
    const saved = await saveDue();
    await worker.withDataContext({ actorUserId: ids.userA }, async (db) => {
      await sql`savepoint reminder_delivery`.execute(db.db);
      await deliverDueReminder(
        db,
        { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
        deps
      );
      await sql`rollback to savepoint reminder_delivery`.execute(db.db);
    });

    expect(await heardBefore()).toEqual([]);
  });

  it("is not sent again when an already delivered job replays", async () => {
    const saved = await saveDue();
    await expect(deliver(saved)).resolves.toBe("delivered");
    await heardBefore();
    heard = [];

    await expect(deliver(saved)).resolves.toBe("already_delivered");
    expect(await heardBefore()).toEqual([]);
  });
});

describe("the API's owner re-read", () => {
  it("returns the stored reminder as a background reply for the owner's Main drawer", async () => {
    const saved = await saveDue(ids.userA, "call mum");
    await deliver(saved);

    const message = await readReminderArrival(app, arrivalOf(saved));
    expect(message).toEqual({
      actorUserId: ids.userA,
      mainThreadId: saved.threadId,
      drawerThreadId: saved.threadId,
      record: {
        kind: "reply",
        text: expect.stringContaining("call mum"),
        messageId: saved.reservedMessageId,
        background: true
      }
    });
  });

  it("finds nothing when the payload names another owner's reminder", async () => {
    const saved = await saveDue(ids.userA);
    await deliver(saved);
    const otherMain = await mainThreadId(ids.userB);

    await expect(readReminderArrival(app, arrivalOf(saved, ids.userB))).resolves.toBeUndefined();
    // Row access rules hide the message even when the thread named is the other owner's Main.
    await expect(
      readReminderArrival(app, { ...arrivalOf(saved, ids.userB), threadId: otherMain })
    ).resolves.toBeUndefined();
  });

  it("finds nothing for an ordinary reply or a reminder that is not yet delivered", async () => {
    const threadId = await mainThreadId(ids.userA);
    const ordinary = await insertMessage(ids.userA, threadId, "assistant", "Just a reply");
    const arrival = { actorUserId: ids.userA, threadId, messageId: ordinary };
    await expect(readReminderArrival(app, arrival)).resolves.toBeUndefined();

    const queued = await saveDue();
    await expect(readReminderArrival(app, arrivalOf(queued))).resolves.toBeUndefined();
  });

  it("finds nothing when the payload names a thread that is not Main", async () => {
    const saved = await saveDue();
    await deliver(saved);
    const side = await asOwner(ids.userA, (db) => chat.openNewThread(db, { title: "Side" }));

    await expect(
      readReminderArrival(app, { ...arrivalOf(saved), threadId: side.id })
    ).resolves.toBeUndefined();
    // The side chat is now the drawer's current thread, so the drawer is not on Main.
    await expect(readReminderArrival(app, arrivalOf(saved))).resolves.toMatchObject({
      mainThreadId: saved.threadId,
      drawerThreadId: side.id
    });
  });
});

describe("the API listener", () => {
  it("hands a committed delivery to the session manager once", async () => {
    const delivered: MainBackgroundMessage[] = [];
    const running = startReminderArrivalListener({
      connectionString: connectionStrings.app,
      read: (arrival) => readReminderArrival(app, arrival),
      deliver: (message) => delivered.push(message) > 0,
      warn: (error) => {
        throw error;
      }
    });
    await running.ready;
    try {
      const saved = await saveDue(ids.userA, "water the plants");
      await deliver(saved);
      await deliver(saved);
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      await heardBefore();
      expect(delivered[0]?.record.messageId).toBe(saved.reservedMessageId);
    } finally {
      await running.stop();
    }
    expect(delivered).toHaveLength(1);
  });
});
