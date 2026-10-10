import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { cancelReminder, listReminders } from "../../packages/chat/src/reminders/cancel.js";
import {
  CHAT_DELIVER_REMINDER_QUEUE,
  deliverDueReminder,
  enqueueReminderDelivery,
  runReminderDeliveryJob,
  type DeliverReminderJobPayload
} from "../../packages/chat/src/reminders/deliver.js";
import {
  ReminderRepository,
  type SavedReminder
} from "../../packages/chat/src/reminders/repository.js";
import { REMINDER_OPEN_LIMIT } from "../../packages/chat/src/reminders/wording.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const chat = new ChatRepository();
const reminders = new ReminderRepository();
const deps = { chat, reminders };

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let appBoss: PgBoss;
let bootstrap: pg.Client;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  appBoss = createPgBossClient(connectionStrings.app);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([appBoss.start(), bootstrap.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([
    appBoss?.stop({ graceful: false }),
    appDb?.destroy(),
    workerDb?.destroy(),
    bootstrap?.end()
  ]);
});

function asOwner<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return app.withDataContext({ actorUserId }, work);
}

function asWorker<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return worker.withDataContext({ actorUserId }, work);
}

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

/** Saves a reminder and enqueues its delivery in one transaction, the way the chat does. */
async function save(
  actorUserId: string,
  text: string
): Promise<SavedReminder & { threadId: string; sourceMessageId: string }> {
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
        body: `remind me in 1 minute to ${text}`,
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const saved = await reminders.create(db, {
      threadId,
      sourceMessageId: source.id,
      delaySeconds: 60,
      text
    });
    await enqueueReminderDelivery(appBoss, db, actorUserId, saved);
    return { ...saved, threadId, sourceMessageId: source.id };
  });
}

function payload(saved: SavedReminder, actorUserId: string): DeliverReminderJobPayload {
  return { actorUserId, resourceId: saved.id, version: saved.version };
}

function deliver(saved: SavedReminder, actorUserId: string, chatRepo: ChatRepository = chat) {
  return asWorker(actorUserId, (db) =>
    deliverDueReminder(db, payload(saved, actorUserId), { reminders, chat: chatRepo })
  );
}

/** Moves a reminder's due time into the past. Triggers are off so the stored time can change. */
async function makeDue(reminderId: string, secondsAgo = 5): Promise<void> {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      `UPDATE app.chat_reminders SET due_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [reminderId, secondsAgo]
    );
    await bootstrap.query(
      `UPDATE pgboss.job SET start_after = now() - make_interval(secs => $2)
         WHERE name = $3 AND data->>'resourceId' = $1`,
      [reminderId, secondsAgo, CHAT_DELIVER_REMINDER_QUEUE]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}

async function readRow(reminderId: string) {
  const result = await bootstrap.query<{
    state: string;
    context_state: string;
    late: boolean | null;
    delivered_at: Date | null;
    reminder_text: string;
  }>(
    `SELECT state, context_state, late, delivered_at, reminder_text
       FROM app.chat_reminders WHERE id = $1`,
    [reminderId]
  );
  return result.rows[0]!;
}

async function readReservation(reminderId: string) {
  const result = await bootstrap.query<{ reserved_message_id: string }>(
    "SELECT reserved_message_id FROM app.chat_reminders WHERE id = $1",
    [reminderId]
  );
  return { reservedMessageId: result.rows[0]!.reserved_message_id };
}

async function deliveredMessages(reminderId: string) {
  const result = await bootstrap.query<{ id: string }>(
    `SELECT m.id FROM app.chat_messages m
       JOIN app.chat_reminders r ON r.reserved_message_id = m.id
      WHERE r.id = $1`,
    [reminderId]
  );
  return result.rows;
}

async function messageExists(messageId: string): Promise<boolean> {
  const result = await bootstrap.query(`SELECT 1 FROM app.chat_messages WHERE id = $1`, [
    messageId
  ]);
  return result.rowCount === 1;
}

function openCount(actorUserId: string): Promise<number> {
  return asOwner(actorUserId, (db) => reminders.openCountLocked(db, actorUserId));
}

/** Resolves once some session is waiting on a row lock over the reminders table. */
async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await bootstrap.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%chat_reminders%'`
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no session started waiting on the reminder lock");
}

/** A chat repository whose reserved-message insert waits for a gate, then posts or throws. */
function pausedChat(outcome: "post" | "throw") {
  let release!: () => void;
  let paused!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (paused = resolve));
  const repo = {
    getMainThread: chat.getMainThread.bind(chat),
    insertReservedAssistantMessage: async (
      ...args: Parameters<ChatRepository["insertReservedAssistantMessage"]>
    ) => {
      paused();
      await gate;
      if (outcome === "throw") throw new Error("delivery failed after pausing");
      return chat.insertReservedAssistantMessage(...args);
    }
  } as unknown as ChatRepository;
  return { repo, reached, release };
}

/** Cancels the way a turn does, holding the thread lock the turn takes first. */
function cancelInTurn(actorUserId: string, threadId: string, target: string | null) {
  return asOwner(actorUserId, async (db) => {
    await sql`select id from app.chat_threads where id = ${threadId} for no key update`.execute(
      db.db
    );
    return cancelReminder(db, reminders, target);
  });
}

describe("cancelling before delivery", () => {
  it("cancels a waiting reminder, frees its slot, and the job posts nothing", async () => {
    const saved = await save(ids.userA, "water the plants");
    const before = await openCount(ids.userA);

    const result = await cancelInTurn(ids.userA, saved.threadId, "water the plants");
    expect(result).toMatchObject({ kind: "cancelled", reminder: { id: saved.id } });

    const row = await readRow(saved.id);
    expect(row).toMatchObject({ state: "cancelled", delivered_at: null, late: null });
    expect(await openCount(ids.userA)).toBe(before - 1);

    await makeDue(saved.id);
    await expect(deliver(saved, ids.userA)).resolves.toBe("cancelled");
    await expect(
      asWorker(ids.userA, (db) =>
        runReminderDeliveryJob(
          db,
          { data: payload(saved, ids.userA), retryCount: 8, retryLimit: 8 },
          deps
        )
      )
    ).resolves.toBe("cancelled");
    expect(await deliveredMessages(saved.id)).toEqual([]);
    expect((await readRow(saved.id)).state).toBe("cancelled");
    expect(await messageExists(saved.sourceMessageId)).toBe(true);
  });

  it("answers already cancelled when asked again", async () => {
    const saved = await save(ids.userA, "call the vet");
    await cancelInTurn(ids.userA, saved.threadId, "call the vet");
    const again = await cancelInTurn(ids.userA, saved.threadId, "call the vet");
    expect(again).toMatchObject({ kind: "already_cancelled", reminder: { id: saved.id } });
  });
});

describe("cancelling after delivery", () => {
  it("says already delivered, keeps the message, and frees the context slot", async () => {
    const saved = await save(ids.userA, "take the bins out");
    await makeDue(saved.id);
    await expect(deliver(saved, ids.userA)).resolves.toBe("delivered");
    const before = await openCount(ids.userA);

    const result = await cancelInTurn(ids.userA, saved.threadId, "take the bins out");
    expect(result).toMatchObject({ kind: "already_delivered", reminder: { id: saved.id } });

    const row = await readRow(saved.id);
    expect(row).toMatchObject({ state: "delivered", context_state: "dismissed" });
    expect(row.delivered_at).not.toBeNull();
    expect(await deliveredMessages(saved.id)).toHaveLength(1);
    expect(await messageExists(saved.sourceMessageId)).toBe(true);
    expect(await openCount(ids.userA)).toBe(before - 1);

    const again = await cancelInTurn(ids.userA, saved.threadId, "take the bins out");
    expect(again).toMatchObject({ kind: "already_delivered" });
    expect(await openCount(ids.userA)).toBe(before - 1);
  });

  it("lets a full owner save again once a delivered reminder is cancelled", async () => {
    const first = await save(ids.userD, "the first one");
    for (let n = 2; n <= REMINDER_OPEN_LIMIT; n += 1) await save(ids.userD, `filler number ${n}`);
    await makeDue(first.id);
    await expect(deliver(first, ids.userD)).resolves.toBe("delivered");
    await expect(save(ids.userD, "one too many")).rejects.toThrow(/chat_reminder_capacity_reached/);

    const result = await cancelInTurn(ids.userD, first.threadId, "the first one");
    expect(result).toMatchObject({ kind: "already_delivered", reminder: { id: first.id } });
    await expect(save(ids.userD, "fits now")).resolves.toMatchObject({ version: 1 });
  });
});

describe("cancel and delivery race on the row lock", () => {
  it("waits for a paused delivery that posts, then answers already delivered", async () => {
    const saved = await save(ids.userA, "check the oven");
    await makeDue(saved.id);
    const paused = pausedChat("post");

    const delivery = deliver(saved, ids.userA, paused.repo);
    await paused.reached;
    const cancel = cancelInTurn(ids.userA, saved.threadId, "check the oven");
    await waitForLockWaiter();
    paused.release();

    await expect(delivery).resolves.toBe("delivered");
    await expect(cancel).resolves.toMatchObject({ kind: "already_delivered" });
    expect(await readRow(saved.id)).toMatchObject({
      state: "delivered",
      context_state: "dismissed"
    });
    expect(await deliveredMessages(saved.id)).toHaveLength(1);
  });

  it("waits for a paused delivery that rolls back, then cancels and the retry posts nothing", async () => {
    const saved = await save(ids.userA, "move the car");
    await makeDue(saved.id);
    const paused = pausedChat("throw");

    const delivery = deliver(saved, ids.userA, paused.repo);
    await paused.reached;
    const cancel = cancelInTurn(ids.userA, saved.threadId, "move the car");
    await waitForLockWaiter();
    paused.release();

    await expect(delivery).rejects.toThrow("delivery failed after pausing");
    await expect(cancel).resolves.toMatchObject({ kind: "cancelled" });
    await expect(deliver(saved, ids.userA)).resolves.toBe("cancelled");
    expect(await readRow(saved.id)).toMatchObject({ state: "cancelled" });
    expect(await deliveredMessages(saved.id)).toEqual([]);
  });

  it("makes a delivery that arrives after the cancel post nothing", async () => {
    const saved = await save(ids.userA, "feed the cat");
    await makeDue(saved.id);

    let releaseCancel!: () => void;
    const held = new Promise<void>((resolve) => (releaseCancel = resolve));
    let cancelLocked!: () => void;
    const locked = new Promise<void>((resolve) => (cancelLocked = resolve));
    const cancel = asOwner(ids.userA, async (db) => {
      const result = await cancelReminder(db, reminders, "feed the cat");
      cancelLocked();
      await held;
      return result;
    });
    await locked;
    const delivery = deliver(saved, ids.userA);
    await waitForLockWaiter();
    releaseCancel();

    await expect(cancel).resolves.toMatchObject({ kind: "cancelled" });
    await expect(delivery).resolves.toBe("cancelled");
    expect(await deliveredMessages(saved.id)).toEqual([]);
  });
});

describe("choosing what to cancel", () => {
  it("refuses to guess between two waiting reminders and cancels nothing", async () => {
    const one = await save(ids.userC, "pay rent");
    const two = await save(ids.userC, "pay the phone bill");
    const result = await cancelInTurn(ids.userC, one.threadId, "pay");
    expect(result).toMatchObject({ kind: "ambiguous" });
    expect((await readRow(one.id)).state).toBe("queued");
    expect((await readRow(two.id)).state).toBe("queued");

    const noTarget = await cancelInTurn(ids.userC, one.threadId, null);
    expect(noTarget).toMatchObject({ kind: "needs_target" });

    const exact = await cancelInTurn(ids.userC, one.threadId, "pay rent");
    expect(exact).toMatchObject({ kind: "cancelled", reminder: { id: one.id } });
    const onlyOneLeft = await cancelInTurn(ids.userC, one.threadId, null);
    expect(onlyOneLeft).toMatchObject({ kind: "cancelled", reminder: { id: two.id } });
  });

  it("lists open reminders first, then finished ones with their state", async () => {
    const listed = await asOwner(ids.userC, (db) => listReminders(db, reminders));
    expect(listed.open).toEqual([]);
    expect(listed.finished.map((reminder) => [reminder.text, reminder.state])).toEqual([
      ["pay the phone bill", "cancelled"],
      ["pay rent", "cancelled"]
    ]);
  });
});

describe("owner isolation", () => {
  it("never lists or cancels another person's reminder", async () => {
    const saved = await save(ids.userA, "private errand");

    const listed = await asOwner(ids.userB, (db) => listReminders(db, reminders));
    expect([...listed.open, ...listed.finished].map((reminder) => reminder.id)).not.toContain(
      saved.id
    );

    const bThread = await mainThreadId(ids.userB);
    const result = await cancelInTurn(ids.userB, bThread, "private errand");
    expect(["not_found", "none_waiting"]).toContain(result.kind);

    const locked = await asOwner(ids.userB, (db) => reminders.lockForCancel(db, saved.id));
    expect(locked).toBeUndefined();

    const updated = await asOwner(ids.userB, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "cancelled" })
        .where("id", "=", saved.id)
        .executeTakeFirst()
    );
    expect(updated.numUpdatedRows).toBe(0n);
    expect((await readRow(saved.id)).state).toBe("queued");
  });
});

describe("what the database refuses", () => {
  it("does not let the worker cancel or dismiss", async () => {
    const saved = await save(ids.userA, "worker may not cancel");
    await expect(
      asWorker(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "cancelled" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/row-level security/);
    expect((await readRow(saved.id)).state).toBe("queued");

    // The worker can only see queued rows for update, so a delivered one is untouched.
    const delivered = await save(ids.userA, "worker may not dismiss");
    await makeDue(delivered.id);
    await deliver(delivered, ids.userA);
    const dismissed = await asWorker(ids.userA, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ context_state: "dismissed" })
        .where("id", "=", delivered.id)
        .executeTakeFirst()
    );
    expect(dismissed.numUpdatedRows).toBe(0n);
    expect((await readRow(delivered.id)).context_state).toBe("pending");
  });

  it("does not let the app forge a delivery", async () => {
    const saved = await save(ids.userA, "app may not deliver");
    const markDelivered = (db: DataContextDb) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "delivered" })
        .where("id", "=", saved.id)
        .execute();
    await expect(asOwner(ids.userA, markDelivered)).rejects.toThrow(
      /delivery needs its reserved message/
    );

    // With the reserved message written by the app itself, the policy still refuses.
    const { reservedMessageId } = await readReservation(saved.id);
    await expect(
      asOwner(ids.userA, async (db) => {
        await chat.insertReservedAssistantMessage(db, {
          id: reservedMessageId,
          threadId: saved.threadId,
          body: "forged",
          origin: {
            version: 1,
            kind: "reminder",
            event: "delivered",
            reminderId: saved.id,
            late: false
          },
          now: new Date()
        });
        await markDelivered(db);
      })
    ).rejects.toThrow(/row-level security/);
    expect((await readRow(saved.id)).state).toBe("queued");
    expect(await messageExists(reservedMessageId)).toBe(false);

    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ delivered_at: sql<Date>`now()`, late: false })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("does not let the app mark a reminder failed", async () => {
    const saved = await save(ids.userA, "app may not fail it");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "failed" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/row-level security/);
    expect((await readRow(saved.id)).state).toBe("queued");
  });

  it("does not let the app reopen a cancelled reminder", async () => {
    const saved = await save(ids.userA, "stay cancelled");
    await cancelInTurn(ids.userA, saved.threadId, "stay cancelled");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "queued" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/can only be delivered once/);
    expect((await readRow(saved.id)).state).toBe("cancelled");
  });

  it("does not let the app dismiss a waiting reminder or cancel a delivered one", async () => {
    const waiting = await save(ids.userA, "not yet delivered");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ context_state: "dismissed" })
          .where("id", "=", waiting.id)
          .execute()
      )
    ).rejects.toThrow(/identity cannot be changed/);
    expect((await readRow(waiting.id)).context_state).toBe("pending");

    const delivered = await save(ids.userA, "already here");
    await makeDue(delivered.id);
    await deliver(delivered, ids.userA);
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "cancelled" })
          .where("id", "=", delivered.id)
          .execute()
      )
    ).rejects.toThrow(/can only be delivered once/);
    expect((await readRow(delivered.id)).state).toBe("delivered");
  });

  it("does not let the app write any column but state and context", async () => {
    const saved = await save(ids.userA, "keep my words");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "cancelled", reminder_text: "different words" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    expect(await readRow(saved.id)).toMatchObject({
      state: "queued",
      reminder_text: "keep my words"
    });
  });

  it("rolls the cancel back with the transaction", async () => {
    const saved = await save(ids.userA, "stopped turn");
    await expect(
      asOwner(ids.userA, async (db) => {
        await cancelReminder(db, reminders, "stopped turn");
        throw new Error("turn stopped");
      })
    ).rejects.toThrow("turn stopped");
    expect((await readRow(saved.id)).state).toBe("queued");
  });
});
