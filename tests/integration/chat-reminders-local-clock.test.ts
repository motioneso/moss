// #3150: clock-time reminders and their deadlines, against the real schema, policies and worker.

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { cancelReminder } from "../../packages/chat/src/reminders/cancel.js";
import {
  CHAT_DELIVER_REMINDER_QUEUE,
  deliverDueReminder,
  enqueueReminderDelivery,
  registerReminderDeliveryWorker,
  type DeliverReminderJobPayload
} from "../../packages/chat/src/reminders/deliver.js";
import { localWallClock } from "../../packages/chat/src/reminders/local-clock.js";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";
import {
  ReminderRepository,
  type SavedReminder
} from "../../packages/chat/src/reminders/repository.js";
import { reminderDeliveredMessage } from "../../packages/chat/src/reminders/wording.js";
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
let workerBoss: PgBoss;
let bootstrap: pg.Client;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  appBoss = createPgBossClient(connectionStrings.app);
  workerBoss = createPgBossClient(connectionStrings.worker);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([appBoss.start(), workerBoss.start(), bootstrap.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([
    appBoss?.stop({ graceful: false }),
    workerBoss?.stop({ graceful: false }),
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

async function sourceMessage(db: DataContextDb, actorUserId: string, threadId: string) {
  const row = await db.db
    .insertInto("app.chat_messages")
    .values({
      id: randomUUID(),
      thread_id: threadId,
      owner_user_id: actorUserId,
      role: "user",
      status: "stored",
      body: "remind me at a clock time",
      model_metadata: {},
      tool_metadata: {}
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A whole minute at least an hour ahead, so its UTC wall clock names it exactly. */
function nextWholeMinute(afterMs = 3600_000): Date {
  return new Date(Math.ceil((Date.now() + afterMs) / 60_000) * 60_000);
}

/** Saves a clock reminder in UTC and enqueues its delivery, the way the chat does. */
async function saveClock(
  text: string,
  deadlineAfterDueMs: number | null,
  actorUserId: string = ids.userA
): Promise<SavedReminder> {
  const threadId = await mainThreadId(actorUserId);
  const dueAt = nextWholeMinute();
  return asOwner(actorUserId, async (db) => {
    const saved = await reminders.create(db, {
      threadId,
      sourceMessageId: await sourceMessage(db, actorUserId, threadId),
      when: {
        timing: "local_clock",
        dueAt,
        localDue: localWallClock(dueAt, "UTC"),
        timeZone: "UTC",
        deadlineAt:
          deadlineAfterDueMs === null ? null : new Date(dueAt.getTime() + deadlineAfterDueMs)
      },
      text
    });
    await enqueueReminderDelivery(appBoss, db, actorUserId, saved);
    return saved;
  });
}

/**
 * Stands in for downtime: moves the due time, deadline and job into the past as if the worker
 * had been stopped. Triggers are off so the stored times can change; checks still apply.
 */
async function stopWorkerPast(
  reminderId: string,
  dueSecondsAgo: number,
  deadlineSecondsAgo: number | null
): Promise<void> {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      `UPDATE app.chat_reminders
          SET due_at = now() - make_interval(secs => $2),
              deadline_at = CASE WHEN $3::float8 IS NULL THEN NULL
                                 ELSE now() - make_interval(secs => $3::float8) END
        WHERE id = $1`,
      [reminderId, dueSecondsAgo, deadlineSecondsAgo]
    );
    await bootstrap.query(
      `UPDATE pgboss.job SET start_after = now() - make_interval(secs => $2)
         WHERE name = $3 AND data->>'resourceId' = $1`,
      [reminderId, dueSecondsAgo, CHAT_DELIVER_REMINDER_QUEUE]
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
    late: boolean | null;
    timing: string;
    local_due: string | null;
    time_zone: string | null;
    due_at: Date;
    deadline_at: Date | null;
    expired_at: Date | null;
    delivered_at: Date | null;
    reserved_message_id: string;
    thread_id: string;
  }>(`SELECT * FROM app.chat_reminders WHERE id = $1`, [reminderId]);
  return result.rows[0]!;
}

async function postedBodies(reminderId: string): Promise<string[]> {
  const result = await bootstrap.query<{ body: string }>(
    `SELECT m.body FROM app.chat_messages m
       JOIN app.chat_reminders r ON r.reserved_message_id = m.id
      WHERE r.id = $1`,
    [reminderId]
  );
  return result.rows.map((row) => row.body);
}

function payload(saved: SavedReminder): DeliverReminderJobPayload {
  return { actorUserId: ids.userA, resourceId: saved.id, version: saved.version };
}

function deliver(saved: SavedReminder) {
  return asWorker(ids.userA, (db) => deliverDueReminder(db, payload(saved), deps));
}

/** Runs the real delivery worker until the reminder's job settles, then stops it. */
async function runWorkerUntilSettled(reminderId: string): Promise<string[]> {
  const workId = await registerReminderDeliveryWorker(workerBoss, worker, {
    pollingIntervalSeconds: 0.5
  });
  try {
    const states = async () =>
      (
        await bootstrap.query<{ state: string }>(
          `SELECT state FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2`,
          [CHAT_DELIVER_REMINDER_QUEUE, reminderId]
        )
      ).rows.map((row) => row.state);
    let current = await states();
    for (let attempt = 0; attempt < 100 && current[0] !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await states();
    }
    return current;
  } finally {
    await workerBoss.offWork(CHAT_DELIVER_REMINDER_QUEUE, { id: workId });
  }
}

describe("saving a clock reminder through chat", () => {
  it("stores the owner's wall clock, zone and deadline, and confirms in their clock", async () => {
    const threadId = await mainThreadId(ids.userB);
    const persistence = new DataContextChatPersistence({
      dataContext: app,
      chatRepository: chat,
      aiRepository: new AiRepository(),
      boss: appBoss as never,
      localePreferences: {
        get: async (_db: unknown, key: string) =>
          key === "locale" ? { timezone: "Asia/Tokyo", region: "JP", dateFormat: "12" } : null,
        getWithMetadata: async () => null,
        upsert: async () => undefined
      } as never
    });
    const words = "remind me tomorrow at 9am to call the bank, not after 11:30am";
    const plan = recognizeReminderPlan(words);
    expect(plan).toMatchObject({ kind: "clock_request" });

    const turn = await persistence.recordReminderTurn(ids.userB, words, plan!, { threadId });
    if (!turn || turn === "stopped") throw new Error("the reminder turn was not stored");
    expect(turn.reply).toBe(
      "Okay. I'll remind you tomorrow at 9:00 AM: call the bank\n" +
        "If I can't send it by 11:30 AM, I'll skip it."
    );
    expect(turn.origin).toMatchObject({ kind: "reminder", event: "saved" });

    const reminderId = (turn.origin as { reminderId: string }).reminderId;
    const row = await readRow(reminderId);
    expect(row).toMatchObject({ state: "queued", timing: "local_clock", time_zone: "Asia/Tokyo" });
    expect(row.local_due).toMatch(/T09:00$/);
    // Tokyo has no daylight saving, so 09:00 there is always 00:00 UTC and 11:30 is 02:30 UTC.
    expect(row.due_at.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(row.deadline_at!.getTime() - row.due_at.getTime()).toBe(2.5 * 3600_000);
  });

  it("refuses a time already past today and stores no reminder", async () => {
    const threadId = await mainThreadId(ids.userB);
    const persistence = new DataContextChatPersistence({
      dataContext: app,
      chatRepository: chat,
      aiRepository: new AiRepository(),
      boss: appBoss as never
    });
    const before = await bootstrap.query(`SELECT count(*)::int AS n FROM app.chat_reminders`);
    // 00:00 today in the default zone has always passed once the day has begun.
    const words = "remind me today at 00:00 to stretch";
    const turn = await persistence.recordReminderTurn(
      ids.userB,
      words,
      recognizeReminderPlan(words)!,
      {
        threadId
      }
    );
    if (!turn || turn === "stopped") throw new Error("the reminder turn was not stored");
    expect(turn.reply).toMatch(/^It's already past 00:00 today/);
    expect(turn.origin).toMatchObject({ event: "refused", reminderId: null });
    const after = await bootstrap.query(`SELECT count(*)::int AS n FROM app.chat_reminders`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("what the database accepts for a clock reminder", () => {
  async function insertRaw(values: { localDue: string; timeZone: string; dueAt: Date }) {
    const threadId = await mainThreadId(ids.userA);
    return asOwner(ids.userA, async (db) =>
      reminders.create(db, {
        threadId,
        sourceMessageId: await sourceMessage(db, ids.userA, threadId),
        when: { timing: "local_clock", ...values, deadlineAt: null },
        text: "check"
      })
    );
  }

  it("refuses a wall clock that does not name the due instant in its zone", async () => {
    const dueAt = nextWholeMinute();
    await expect(
      insertRaw({ dueAt, localDue: localWallClock(dueAt, "UTC"), timeZone: "Asia/Tokyo" })
    ).rejects.toThrow(/local time does not match its due time/);
  });

  it("refuses a due time already past", async () => {
    const dueAt = new Date(Math.floor((Date.now() - 120_000) / 60_000) * 60_000);
    await expect(
      insertRaw({ dueAt, localDue: localWallClock(dueAt, "UTC"), timeZone: "UTC" })
    ).rejects.toThrow(/due time is out of range/);
  });

  it("refuses a deadline at or before the due time", async () => {
    await expect(saveClock("check", 0)).rejects.toThrow(/chat_reminders_deadline_after_due/);
  });

  it("never lets the owner move the deadline", async () => {
    const saved = await saveClock("water plants", 3600_000);
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ deadline_at: new Date(Date.now() + 86_400_000), state: "cancelled" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied for table chat_reminders/);
  });

  it("refuses a time the clocks skip, even with the instant Postgres would guess", async () => {
    // 02:30 on 2027-03-14 never shows on a New York clock; Postgres still maps it to an instant.
    const guess = await bootstrap.query<{ due: Date }>(
      `SELECT ('2027-03-14T02:30'::timestamp AT TIME ZONE 'America/New_York') AS due`
    );
    await expect(
      insertRaw({
        dueAt: guess.rows[0].due,
        localDue: "2027-03-14T02:30",
        timeZone: "America/New_York"
      })
    ).rejects.toThrow(/local time is skipped by the clocks/);
  });

  it("refuses a deadline more than 12 hours after the reminder", async () => {
    await expect(saveClock("check", 12 * 3600_000 + 60_000, ids.userB)).rejects.toThrow(
      /chat_reminders_deadline_after_due/
    );
  });

  it("refuses a deadline on a reminder set a time from now", async () => {
    const threadId = await mainThreadId(ids.userB);
    const saved = await asOwner(ids.userB, async (db) =>
      reminders.create(db, {
        threadId,
        sourceMessageId: await sourceMessage(db, ids.userB, threadId),
        when: { timing: "relative", delaySeconds: 600 },
        text: "check"
      })
    );
    // Triggers off, so only the table's checks stand between the row and the deadline.
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await expect(
        bootstrap.query(
          `UPDATE app.chat_reminders SET deadline_at = due_at + interval '1 hour' WHERE id = $1`,
          [saved.id]
        )
      ).rejects.toThrow(/chat_reminders_deadline_after_due/);
    } finally {
      await bootstrap.query("ROLLBACK");
    }
  });
});

describe("what the worker may change on a clock reminder", () => {
  function workerSets(reminderId: string, values: Record<string, unknown>) {
    return asWorker(ids.userB, (db) =>
      db.db.updateTable("app.chat_reminders").set(values).where("id", "=", reminderId).execute()
    );
  }

  it.each([
    ["deadline", { deadline_at: new Date(Date.now() + 6 * 3600_000) }],
    ["timing", { timing: "relative", delay_seconds: 600, local_due: null, time_zone: null }],
    ["wall clock", { local_due: "2099-01-01T09:00" }],
    ["time zone", { time_zone: "Asia/Tokyo" }]
  ])("never lets it rewrite the %s", async (_field, values) => {
    const saved = await saveClock("water plants", 3600_000, ids.userB);
    await expect(workerSets(saved.id, values)).rejects.toThrow(/identity cannot be changed/);
  });

  it("never lets it give a failed reminder an expired time", async () => {
    const saved = await saveClock("water plants", 3600_000, ids.userB);
    await expect(
      workerSets(saved.id, { state: "failed", expired_at: new Date(Date.now() + 7200_000) })
    ).rejects.toThrow(/chat_reminders_expired_shape/);
  });
});

describe("a reminder past its deadline", () => {
  it("is skipped by the worker after downtime, never posts, and a replay changes nothing", async () => {
    const saved = await saveClock("call Sam", 600_000);
    await stopWorkerPast(saved.id, 900, 300);

    expect(await runWorkerUntilSettled(saved.id)).toEqual(["completed"]);
    const row = await readRow(saved.id);
    expect(row.state).toBe("expired");
    expect(row.expired_at).not.toBeNull();
    expect(row.delivered_at).toBeNull();
    expect(await postedBodies(saved.id)).toEqual([]);

    expect(await deliver(saved)).toBe("expired");
    expect(await postedBodies(saved.id)).toEqual([]);
    expect((await readRow(saved.id)).state).toBe("expired");
  });

  it("cannot be marked delivered, and its reserved message cannot be written", async () => {
    const saved = await saveClock("pay rent", 600_000);
    await stopWorkerPast(saved.id, 900, 300);
    const row = await readRow(saved.id);

    await expect(
      asWorker(ids.userA, (db) =>
        db.db
          .insertInto("app.chat_messages")
          .values({
            id: row.reserved_message_id,
            thread_id: row.thread_id,
            owner_user_id: ids.userA,
            role: "assistant",
            status: "stored",
            body: "Reminder: pay rent",
            model_metadata: {},
            tool_metadata: {}
          })
          .execute()
      )
    ).rejects.toThrow(/row-level security/);
    await expect(
      asWorker(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "delivered", delivered_at: new Date(), late: true })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/deadline has passed/);
    expect((await readRow(saved.id)).state).toBe("queued");
  });

  it("is reported as skipped when the owner tries to cancel it", async () => {
    const saved = await saveClock("feed the cat", 600_000);
    await stopWorkerPast(saved.id, 900, 300);
    expect(await deliver(saved)).toBe("expired");
    const result = await asOwner(ids.userA, (db) => cancelReminder(db, reminders, "feed the cat"));
    expect(result).toMatchObject({ kind: "already_expired" });
  });
});

describe("a reminder whose deadline has not passed", () => {
  it("cannot be expired early", async () => {
    const saved = await saveClock("stretch", 3600_000);
    await expect(
      asWorker(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "expired" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/can only expire after its deadline/);
  });

  it("posts once, marked late, after downtime inside the deadline", async () => {
    const saved = await saveClock("take the bins out", 3600_000);
    await stopWorkerPast(saved.id, 600, -3000);

    expect(await runWorkerUntilSettled(saved.id)).toEqual(["completed"]);
    const row = await readRow(saved.id);
    expect(row).toMatchObject({ state: "delivered", late: true, expired_at: null });
    expect(await postedBodies(saved.id)).toEqual([
      reminderDeliveredMessage("take the bins out", true)
    ]);

    expect(await deliver(saved)).toBe("already_delivered");
    expect(await postedBodies(saved.id)).toHaveLength(1);
  });

  it("without a deadline, a clock reminder posts on time and is not late", async () => {
    const saved = await saveClock("stand up", null);
    await stopWorkerPast(saved.id, 5, null);
    expect(await deliver(saved)).toBe("delivered");
    expect(await readRow(saved.id)).toMatchObject({ state: "delivered", late: false });
  });
});
