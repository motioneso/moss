import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import {
  CHAT_DELIVER_REMINDER_QUEUE,
  deliverDueReminder,
  enqueueReminderDelivery,
  registerReminderDeliveryWorker,
  type DeliverReminderJobPayload
} from "../../packages/chat/src/reminders/deliver.js";
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

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

/** Saves a reminder and enqueues its delivery in one transaction, the way the chat does. */
async function save(
  actorUserId: string = ids.userA,
  text = "stretch"
): Promise<SavedReminder & { threadId: string }> {
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
    return { ...saved, threadId };
  });
}

/** Only the owner may move their Main chat. */
function setMain(actorUserId: string, threadId: string, isMain: boolean): Promise<unknown> {
  return asOwner(actorUserId, (db) =>
    db.db
      .updateTable("app.chat_threads")
      .set({ is_main: isMain })
      .where("id", "=", threadId)
      .execute()
  );
}

function payload(saved: SavedReminder, actorUserId: string = ids.userA): DeliverReminderJobPayload {
  return { actorUserId, resourceId: saved.id, version: saved.version };
}

function deliver(saved: SavedReminder, input: DeliverReminderJobPayload = payload(saved)) {
  return worker.withDataContext({ actorUserId: input.actorUserId }, (db) =>
    deliverDueReminder(db, input, deps)
  );
}

/** Moves a reminder's due time into the past. Triggers are off so the stored time can change. */
async function makeDue(reminderId: string, secondsAgo: number): Promise<void> {
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
    late: boolean | null;
    delivered_at: Date | null;
    reserved_message_id: string;
  }>(
    `SELECT state, late, delivered_at, reserved_message_id FROM app.chat_reminders WHERE id = $1`,
    [reminderId]
  );
  return result.rows[0]!;
}

async function deliveredMessages(reminderId: string) {
  const result = await bootstrap.query<{
    id: string;
    role: string;
    body: string;
    model_metadata: { origin?: unknown };
  }>(
    `SELECT m.id, m.role, m.body, m.model_metadata
       FROM app.chat_messages m
       JOIN app.chat_reminders r ON r.reserved_message_id = m.id
      WHERE r.id = $1`,
    [reminderId]
  );
  return result.rows;
}

async function jobsFor(reminderId: string) {
  const result = await bootstrap.query<{
    state: string;
    data: Record<string, unknown>;
    start_after: Date;
  }>(
    `SELECT state, data, start_after FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2`,
    [CHAT_DELIVER_REMINDER_QUEUE, reminderId]
  );
  return result.rows;
}

describe("saving a reminder enqueues its delivery atomically", () => {
  it("drops the job when the save rolls back", async () => {
    const threadId = await mainThreadId(ids.userA);
    let reminderId = "";
    await expect(
      asOwner(ids.userA, async (db) => {
        const source = await db.db
          .insertInto("app.chat_messages")
          .values({
            id: randomUUID(),
            thread_id: threadId,
            owner_user_id: ids.userA,
            role: "user",
            status: "stored",
            body: "remind me in 1 minute to roll back",
            model_metadata: {},
            tool_metadata: {}
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        const saved = await reminders.create(db, {
          threadId,
          sourceMessageId: source.id,
          delaySeconds: 60,
          text: "roll back"
        });
        reminderId = saved.id;
        await enqueueReminderDelivery(appBoss, db, ids.userA, saved);
        throw new Error("rolled back on purpose");
      })
    ).rejects.toThrow("rolled back on purpose");

    expect(reminderId).not.toBe("");
    expect(await jobsFor(reminderId)).toHaveLength(0);
    const rows = await bootstrap.query(`SELECT 1 FROM app.chat_reminders WHERE id = $1`, [
      reminderId
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("keeps one job naming only the owner, the reminder and its version, due at the due time", async () => {
    const saved = await save();
    const jobs = await jobsFor(saved.id);

    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0]!.data).sort()).toEqual(["actorUserId", "resourceId", "version"]);
    expect(jobs[0]!.data).toEqual({ actorUserId: ids.userA, resourceId: saved.id, version: 1 });
    expect(Math.abs(new Date(jobs[0]!.start_after).getTime() - saved.dueAt.getTime())).toBeLessThan(
      1000
    );
  });
});

describe("delivering a due reminder", () => {
  it("refuses to run before the due time and writes nothing", async () => {
    const saved = await save();

    await expect(deliver(saved)).rejects.toThrow("before its due time");
    expect((await readRow(saved.id)).state).toBe("queued");
    expect(await deliveredMessages(saved.id)).toHaveLength(0);
  });

  it("delivers once on time, and a replay changes nothing", async () => {
    const saved = await save(ids.userA, "drink water");
    await makeDue(saved.id, 30);

    await expect(deliver(saved)).resolves.toBe("delivered");
    await expect(deliver(saved)).resolves.toBe("already_delivered");

    const row = await readRow(saved.id);
    expect(row.state).toBe("delivered");
    expect(row.late).toBe(false);
    expect(row.delivered_at).not.toBeNull();

    const messages = await deliveredMessages(saved.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: row.reserved_message_id,
      role: "assistant",
      body: reminderDeliveredMessage("drink water", false)
    });
    expect(messages[0]!.model_metadata.origin).toEqual({
      version: 1,
      kind: "reminder",
      event: "delivered",
      reminderId: saved.id,
      late: false
    });
  });

  it("says it is late when it runs more than a minute after the due time", async () => {
    const saved = await save(ids.userA, "call the vet");
    await makeDue(saved.id, 300);

    await expect(deliver(saved)).resolves.toBe("delivered");

    expect((await readRow(saved.id)).late).toBe(true);
    const messages = await deliveredMessages(saved.id);
    expect(messages.map((message) => message.body)).toEqual([
      reminderDeliveredMessage("call the vet", true)
    ]);
  });

  it("ignores a job for an older version of the reminder", async () => {
    const saved = await save();
    await makeDue(saved.id, 30);

    await expect(deliver(saved, { ...payload(saved), version: saved.version + 1 })).resolves.toBe(
      "stale_version"
    );
    expect((await readRow(saved.id)).state).toBe("queued");
    expect(await deliveredMessages(saved.id)).toHaveLength(0);
  });

  it("finds nothing when the job names another person", async () => {
    const saved = await save();
    await makeDue(saved.id, 30);

    await expect(deliver(saved, payload(saved, ids.userB))).resolves.toBe("missing");
    expect((await readRow(saved.id)).state).toBe("queued");
    expect(await deliveredMessages(saved.id)).toHaveLength(0);
  });

  it("does not deliver into a chat that is no longer the owner's Main chat", async () => {
    const saved = await save(ids.userB);
    await makeDue(saved.id, 30);
    await setMain(ids.userB, saved.threadId, false);

    try {
      await expect(deliver(saved, payload(saved, ids.userB))).resolves.toBe("not_main");
      expect((await readRow(saved.id)).state).toBe("queued");
      expect(await deliveredMessages(saved.id)).toHaveLength(0);
    } finally {
      await setMain(ids.userB, saved.threadId, true);
    }
  });

  it("does not deliver into the old chat when another chat has become Main", async () => {
    const saved = await save(ids.userB);
    await makeDue(saved.id, 30);
    await setMain(ids.userB, saved.threadId, false);
    const other = await asOwner(ids.userB, (db) => chat.openNewThread(db, { title: "Other" }));
    await setMain(ids.userB, other.id, true);

    try {
      await expect(deliver(saved, payload(saved, ids.userB))).resolves.toBe("not_main");
      expect((await readRow(saved.id)).state).toBe("queued");
      expect(await deliveredMessages(saved.id)).toHaveLength(0);
    } finally {
      await setMain(ids.userB, other.id, false);
      await setMain(ids.userB, saved.threadId, true);
    }
  });

  it("delivers once when two workers run the same job at the same time", async () => {
    const saved = await save(ids.userA, "stand up");
    await makeDue(saved.id, 30);

    const outcomes = await Promise.all([deliver(saved), deliver(saved)]);

    expect(outcomes.sort()).toEqual(["already_delivered", "delivered"]);
    expect(await deliveredMessages(saved.id)).toHaveLength(1);
  });

  it("leaves the reminder waiting when delivery rolls back, then a retry delivers once", async () => {
    const saved = await save(ids.userA, "water the plants");
    await makeDue(saved.id, 30);

    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, async (db) => {
        await expect(deliverDueReminder(db, payload(saved), deps)).resolves.toBe("delivered");
        throw new Error("worker crashed before commit");
      })
    ).rejects.toThrow("worker crashed before commit");

    expect((await readRow(saved.id)).state).toBe("queued");
    expect(await deliveredMessages(saved.id)).toHaveLength(0);

    await expect(deliver(saved)).resolves.toBe("delivered");
    await expect(deliver(saved)).resolves.toBe("already_delivered");
    expect(await deliveredMessages(saved.id)).toHaveLength(1);
  });
});

describe("the delivery worker", () => {
  it("recovers a reminder missed while it was stopped, exactly once and marked late", async () => {
    const saved = await save(ids.userA, "take the bins out");
    await makeDue(saved.id, 600);

    const workId = await registerReminderDeliveryWorker(workerBoss, worker, {
      pollingIntervalSeconds: 0.5
    });
    try {
      let jobs = await jobsFor(saved.id);
      for (let attempt = 0; attempt < 100 && jobs[0]?.state !== "completed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        jobs = await jobsFor(saved.id);
      }
      expect(jobs.map((job) => job.state)).toEqual(["completed"]);
    } finally {
      await workerBoss.offWork(CHAT_DELIVER_REMINDER_QUEUE, { id: workId });
    }

    const row = await readRow(saved.id);
    expect(row.state).toBe("delivered");
    expect(row.late).toBe(true);
    const messages = await deliveredMessages(saved.id);
    expect(messages.map((message) => message.body)).toEqual([
      reminderDeliveredMessage("take the bins out", true)
    ]);
  });
});
