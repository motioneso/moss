import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type DataContextDb } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  ReminderRepository,
  type ReminderTimingInput
} from "../../packages/chat/src/reminders/repository.js";
import {
  deliverDueReminder,
  enqueueReminderDelivery
} from "../../packages/chat/src/reminders/deliver.js";
import {
  pauseReminderById,
  resumeReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { listScheduledReminders } from "../../packages/chat/src/reminders/settings.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
const workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
const app = new DataContextRunner(appDb);
const worker = new DataContextRunner(workerDb);
const boss = createPgBossClient(connectionStrings.app);
const workerBoss = createPgBossClient(connectionStrings.worker);
const bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
const reminders = new ReminderRepository();
const chat = new ChatRepository();
const deps = { reminders, chat, boss: workerBoss };
const owner = <T>(work: (db: DataContextDb) => Promise<T>) =>
  app.withDataContext({ actorUserId: ids.userA }, work);
beforeAll(async () => {
  await resetFoundationDatabase();
  await Promise.all([boss.start(), workerBoss.start(), bootstrap.connect()]);
});
afterAll(async () => {
  await Promise.allSettled([
    boss.stop({ graceful: false }),
    workerBoss.stop({ graceful: false }),
    bootstrap.end(),
    appDb.destroy(),
    workerDb.destroy()
  ]);
});
async function save(
  when: ReminderTimingInput = {
    timing: "relative",
    delaySeconds: 60,
    repeat: { kind: "interval", seconds: 60 }
  }
) {
  return owner(async (db) => {
    const thread =
      (await chat.getMainThread(db, ids.userA)) ??
      (await chat.openNewThread(db, { title: "Main" }));
    const source = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: thread.id,
        owner_user_id: ids.userA,
        role: "user",
        status: "stored",
        body: "remind me every minute to stand up",
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const reminder = await reminders.create(db, {
      threadId: thread.id,
      sourceMessageId: source.id,
      text: "stand up",
      when
    });
    await enqueueReminderDelivery(boss, db, ids.userA, reminder);
    return { ...reminder, threadId: thread.id };
  });
}
async function makeDue(id: string) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at=now()-interval '5 minutes 15 seconds' WHERE id=$1",
      [id]
    );
    await bootstrap.query("COMMIT");
  } catch (e) {
    await bootstrap.query("ROLLBACK");
    throw e;
  }
}
const deliver = (saved: { id: string; version: number }) =>
  worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    deliverDueReminder(
      db,
      { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
      deps
    )
  );
async function current(id: string) {
  return owner((db) =>
    db.db
      .selectFrom("app.chat_reminders")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  );
}

describe("fixed recurring delivery", () => {
  it.each(["daily", "weekly"] as const)(
    "advances %s local cadence after one catch-up",
    async (kind) => {
      const future = new Date(Date.now() + 86400000);
      const localDue = future.toISOString().slice(0, 10) + "T09:00";
      const saved = await save({
        timing: "local_clock",
        dueAt: new Date(localDue + ":00Z"),
        localDue,
        timeZone: "UTC",
        deadlineAt: null,
        repeat: { kind }
      });
      const step = kind === "weekly" ? 7 : 1;
      await bootstrap.query("BEGIN");
      try {
        await bootstrap.query("SET LOCAL session_replication_role = replica");
        await bootstrap.query(
          `UPDATE app.chat_reminders SET local_due=to_char((now() AT TIME ZONE 'UTC')::date - $2::int, 'YYYY-MM-DD') || 'T09:00', due_at=(((now() AT TIME ZONE 'UTC')::date - $2::int) + time '09:00') AT TIME ZONE 'UTC' WHERE id=$1`,
          [saved.id, step]
        );
        await bootstrap.query("COMMIT");
      } catch (e) {
        await bootstrap.query("ROLLBACK");
        throw e;
      }
      const previous = await current(saved.id);
      expect(await deliver(saved)).toBe("delivered");
      const next = await current(saved.id);
      expect(
        (
          await owner((db) =>
            editReminderById(
              db,
              boss,
              ids.userA,
              saved.id,
              next.version,
              {
                text: null,
                delaySeconds: null,
                localDue: next.local_due!,
                deadline: "keep",
                localDeadline: null
              },
              "Africa/Abidjan"
            )
          )
        ).kind
      ).toBe("changed");
      expect((await current(saved.id)).time_zone).toBe("Africa/Abidjan");
      expect(next.due_at.getTime()).toBeGreaterThan(Date.now());
      expect(next.local_due?.slice(11)).toBe("09:00");
      const days =
        (Date.parse(next.local_due!.slice(0, 10)) - Date.parse(previous.local_due!.slice(0, 10))) /
        86400000;
      expect(days % step).toBe(0);
      expect(
        (await owner(listScheduledReminders)).find((t) => t.id === saved.id)?.runs
      ).toHaveLength(1);
    }
  );
  it("SQL advancement resolves both DST transitions using the SDK policy", async () => {
    const result = await bootstrap.query(
      `SELECT app.chat_reminder_repeat_instant('2026-03-08T02:30','America/Los_Angeles') spring, app.chat_reminder_repeat_instant('2026-11-01T01:30','America/Los_Angeles') fall, app.chat_reminder_repeat_instant('2026-10-04T02:15','Australia/Lord_Howe') half_hour`
    );
    expect(result.rows[0].spring.toISOString()).toBe("2026-03-08T10:30:00.000Z");
    expect(result.rows[0].fall.toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(result.rows[0].half_hour.toISOString()).toBe("2026-10-03T15:45:00.000Z");
  });

  it("catches up once, queues a future occurrence and preserves earlier context/results", async () => {
    const saved = await save();
    await makeDue(saved.id);
    const first = await current(saved.id);
    expect(await deliver(saved)).toBe("delivered");
    expect(await deliver(saved)).toBe("stale_version");
    const next = await current(saved.id);
    expect(next.state).toBe("queued");
    expect(next.version).toBe(2);
    expect(next.due_at.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(next.due_at.getTime()).toBeLessThan(Date.now() + 60_000);
    const jobs = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name='chat.deliver-reminder' AND data->>'resourceId'=$1 AND (data->>'version')::int=2",
      [saved.id]
    );
    expect(jobs.rows).toHaveLength(1);
    expect(Object.keys(jobs.rows[0]!.data).sort()).toEqual([
      "actorUserId",
      "resourceId",
      "version"
    ]);
    const result = await owner((db) =>
      reminders.readNotificationResult(db, saved.id, first.reserved_message_id)
    );
    expect(result?.messageId).toBe(first.reserved_message_id);
    expect(result?.version).toBe(1);
    expect(await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reservedMessageId: first.reserved_message_id })
      ])
    );
    await makeDue(saved.id);
    expect(await deliver({ id: saved.id, version: 2 })).toBe("delivered");
    expect((await current(saved.id)).version).toBe(3);
    expect(
      (await owner(listScheduledReminders)).find((task) => task.id === saved.id)?.runs
    ).toHaveLength(2);
    expect(
      (
        await owner((db) =>
          reminders.readNotificationResult(db, saved.id, first.reserved_message_id)
        )
      )?.version
    ).toBe(1);
    await owner((db) => reminders.acknowledgeMain(db, saved.threadId, [first.reserved_message_id]));
    expect(
      (await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).some(
        (r) => r.reservedMessageId === first.reserved_message_id
      )
    ).toBe(false);
  });
  it("serializes competing workers and never advances without a persisted occurrence", async () => {
    const saved = await save();
    await makeDue(saved.id);
    expect((await Promise.all([deliver(saved), deliver(saved)])).sort()).toEqual([
      "delivered",
      "stale_version"
    ]);
    const row = await current(saved.id);
    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({
            version: row.version + 1,
            reserved_message_id: randomUUID(),
            due_at: new Date(Date.now() + 60_000)
          })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/persisted run/);
  });
  it("keeps pause/resume/edit/delete effective after firing and preserves messages on deletion", async () => {
    const saved = await save();
    await makeDue(saved.id);
    await deliver(saved);
    const row = await current(saved.id);
    const oldMessage = await owner(
      async (db) =>
        (await listScheduledReminders(db)).find((task) => task.id === saved.id)!.runs[0]!.message!
          .id
    );
    expect(
      (
        await owner((db) =>
          editReminderById(
            db,
            boss,
            ids.userA,
            saved.id,
            row.version,
            {
              text: "drink water",
              delaySeconds: null,
              localDue: null,
              deadline: "keep",
              localDeadline: null
            },
            "UTC"
          )
        )
      ).kind
    ).toBe("changed");
    expect((await current(saved.id)).repeat_kind).toBe("interval");
    expect(await deliver({ id: saved.id, version: row.version })).toBe("stale_version");
    await owner((db) => pauseReminderById(db, saved.id));
    expect(await deliver({ id: saved.id, version: row.version + 1 })).toBe("paused");
    await owner((db) => resumeReminderById(db, boss, ids.userA, saved.id));
    const resumed = await current(saved.id);
    await owner((db) => deleteReminderById(db, saved.id));
    expect(await deliver({ id: saved.id, version: resumed.version })).toBe("missing");
    expect(
      (await bootstrap.query("SELECT id FROM app.chat_messages WHERE id=$1", [oldMessage])).rows
    ).toHaveLength(1);
  });
  it("run history is owner-only, including admins; a policy mutation exposes the negative", async () => {
    const saved = await save();
    await makeDue(saved.id);
    await deliver(saved);
    const read = () =>
      app.withDataContext({ actorUserId: ids.userB }, (db) =>
        db.db
          .selectFrom("app.chat_reminder_runs")
          .selectAll()
          .where("reminder_id", "=", saved.id)
          .execute()
      );
    expect(await read()).toEqual([]);
    const admin = ids.adminUser;
    expect(
      await app.withDataContext({ actorUserId: admin }, (db) =>
        db.db
          .selectFrom("app.chat_reminder_runs")
          .selectAll()
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).toEqual([]);
    try {
      await bootstrap.query(
        "ALTER POLICY chat_reminder_runs_select ON app.chat_reminder_runs USING (true)"
      );
      expect(await read()).toHaveLength(1);
    } finally {
      await bootstrap.query(
        "ALTER POLICY chat_reminder_runs_select ON app.chat_reminder_runs USING (owner_user_id=app.current_actor_user_id() AND EXISTS (SELECT 1 FROM app.chat_reminders r WHERE r.id=reminder_id AND r.owner_user_id=app.current_actor_user_id()))"
      );
    }
    expect(await read()).toEqual([]);
    await expect(
      owner((db) =>
        db.db
          .insertInto("app.chat_reminder_runs")
          .values({
            id: randomUUID(),
            reminder_id: saved.id,
            owner_user_id: ids.userA,
            version: 99,
            due_at: new Date(),
            at: new Date(),
            outcome: "expired",
            message_id: null,
            late: false
          })
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
  });
  it("keeps earlier runs and the final one-time result after repetition is removed", async () => {
    const saved = await save();
    await makeDue(saved.id);
    await deliver(saved);
    const row = await current(saved.id);
    expect(
      (
        await owner((db) =>
          editReminderById(
            db,
            boss,
            ids.userA,
            saved.id,
            row.version,
            {
              repeat: "remove",
              text: null,
              delaySeconds: null,
              localDue: null,
              deadline: "keep",
              localDeadline: null
            },
            "UTC"
          )
        )
      ).kind
    ).toBe("changed");
    await makeDue(saved.id);
    expect(await deliver({ id: saved.id, version: row.version + 1 })).toBe("delivered");
    const task = (await owner(listScheduledReminders)).find((t) => t.id === saved.id)!;
    expect(task.state).toBe("completed");
    expect(task.runs).toHaveLength(2);
    expect(new Set(task.runs.map((r) => r.message!.id)).size).toBe(2);
    await owner((db) => reminders.dismissContext(db, saved.id));
    expect(
      (await owner((db) => reminders.listPendingMain(db, saved.threadId, 20))).some((run) =>
        task.runs.some((result) => result.message?.id === run.reservedMessageId)
      )
    ).toBe(false);
    for (const run of task.runs) {
      expect(
        await owner((db) => reminders.readNotificationResult(db, saved.id, run.message!.id))
      ).toBeUndefined();
    }
  });
  it("queues an occurrence exactly at the saved stop time", async () => {
    const saved = await save();
    await makeDue(saved.id);
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await bootstrap.query(
        "UPDATE app.chat_reminders SET deadline_at=due_at+interval '6 minutes' WHERE id=$1",
        [saved.id]
      );
      await bootstrap.query("COMMIT");
    } catch (e) {
      await bootstrap.query("ROLLBACK");
      throw e;
    }
    expect(await deliver(saved)).toBe("delivered");
    const next = await current(saved.id);
    expect(next.state).toBe("queued");
    expect(next.due_at.getTime()).toBe(next.deadline_at!.getTime());
  });
  it("expires overdue repeating work without posting", async () => {
    const saved = await save();
    await makeDue(saved.id);
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await bootstrap.query(
        "UPDATE app.chat_reminders SET deadline_at=now()-interval '1 minute' WHERE id=$1",
        [saved.id]
      );
      await bootstrap.query("COMMIT");
    } catch (e) {
      await bootstrap.query("ROLLBACK");
      throw e;
    }
    expect(await deliver(saved)).toBe("expired");
    const task = (await owner(listScheduledReminders)).find((t) => t.id === saved.id)!;
    expect(task.state).toBe("expired");
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]!.message).toBeNull();
  });
});
