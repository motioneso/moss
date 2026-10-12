import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, createPushQueuePort } from "@moss/jobs";
import { createNotificationPreferencePort } from "@moss/module-registry";
import {
  NotificationsRepository,
  runPushDeliverJob,
  type QuietHoursPort
} from "@moss/notifications";
import { PreferencesRepository } from "@moss/structured-state";

import { ChatRepository } from "../../packages/chat/src/repository.js";
import { deliverDueReminder } from "../../packages/chat/src/reminders/deliver.js";
import {
  CHAT_NOTIFY_REMINDER_QUEUE,
  enqueueReminderNotification,
  runReminderNotificationJob,
  isReminderNotificationActive,
  type ReminderNotificationPayload
} from "../../packages/chat/src/reminders/notifications.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const chat = new ChatRepository();
const reminders = new ReminderRepository();
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let boss: PgBoss;
let bootstrap: pg.Client;
let notifications: NotificationsRepository;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  boss = createPgBossClient(connectionStrings.worker);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([boss.start(), bootstrap.connect()]);
  notifications = new NotificationsRepository(
    undefined,
    createNotificationPreferencePort(),
    createPushQueuePort(boss)
  );
});

afterAll(async () => {
  await Promise.allSettled([
    boss?.stop({ graceful: false }),
    appDb?.destroy(),
    workerDb?.destroy(),
    bootstrap?.end()
  ]);
});

function asOwner<T>(work: (db: DataContextDb) => Promise<T>, actorUserId: string = ids.userA) {
  return app.withDataContext({ actorUserId }, work);
}

async function due(text = "stretch") {
  const saved = await asOwner(async (db) => {
    const main =
      (await chat.getMainThread(db, ids.userA)) ??
      (await chat.openNewThread(db, { title: "Main" }));
    const source = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: main.id,
        owner_user_id: ids.userA,
        role: "user",
        status: "stored",
        body: `remind me in 1 minute to ${text}`,
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return reminders.create(db, {
      threadId: main.id,
      sourceMessageId: source.id,
      when: { timing: "relative", delaySeconds: 60 },
      text
    });
  });
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = now() - interval '1 second' WHERE id = $1",
      [saved.id]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
  const outcome = await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    deliverDueReminder(
      db,
      { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
      {
        chat,
        reminders,
        enqueueNotification: (scopedDb, reminder) =>
          enqueueReminderNotification(boss, scopedDb, reminder)
      }
    )
  );
  expect(outcome).toBe("delivered");
  const jobs = await bootstrap.query<{ data: ReminderNotificationPayload }>(
    "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
    [CHAT_NOTIFY_REMINDER_QUEUE, saved.id]
  );
  expect(jobs.rows).toHaveLength(1);
  return jobs.rows[0]!.data;
}

function notify(payload: ReminderNotificationPayload, repository = notifications) {
  return worker.withDataContext({ actorUserId: payload.actorUserId }, (db) =>
    runReminderNotificationJob(db, payload, repository)
  );
}

it("notification failure and concurrent retry leave the one delivered chat result intact", async () => {
  const payload = await due();
  expect(Object.keys(payload).sort()).toEqual([
    "actorUserId",
    "idempotencyKey",
    "resourceId",
    "version"
  ]);
  class BrokenNotifications extends NotificationsRepository {
    override async create(): Promise<never> {
      throw new Error("temporary notification failure");
    }
  }
  await expect(notify(payload, new BrokenNotifications())).rejects.toThrow(
    "temporary notification failure"
  );
  const result = await bootstrap.query("SELECT state FROM app.chat_reminders WHERE id = $1", [
    payload.resourceId
  ]);
  expect(result.rows[0].state).toBe("delivered");
  expect((await Promise.all([notify(payload), notify(payload)])).sort()).toEqual([
    "already_created",
    "created"
  ]);
  const rows = await asOwner((db) => notifications.listVisible(db));
  const matching = rows.notifications.filter((item) => item.event_key === payload.idempotencyKey);
  expect(matching).toHaveLength(1);
  expect(matching[0]).toMatchObject({
    module_id: "chat",
    urgency: "normal",
    body: "Reminder: stretch",
    href: "/today"
  });
  await asOwner((db) => notifications.markRead(db, matching[0]!.id));
  expect(await notify(payload)).toBe("already_created");
  const read = await asOwner((db) => notifications.getById(db, matching[0]!.id));
  expect(read?.read_at).not.toBeNull();
  const messages = await bootstrap.query(
    "SELECT count(*)::int AS count FROM app.chat_messages WHERE id = $1",
    [payload.idempotencyKey]
  );
  expect(messages.rows[0].count).toBe(1);
  const push = await bootstrap.query(
    "SELECT data FROM pgboss.job WHERE name = 'notifications.push.deliver' AND data->>'notificationId' = $1",
    [matching[0]!.id]
  );
  expect(push.rows).toHaveLength(1);
  expect(Object.keys(push.rows[0].data).sort()).toEqual([
    "actorUserId",
    "notificationId",
    "recipientUserId"
  ]);
});

it("holds only the notification at the saved non-UTC boundary and deduplicates its summary job", async () => {
  const payload = await due("check the oven");
  const now = new Date();
  const releaseAt = new Date(now);
  releaseAt.setUTCSeconds(0, 0);
  releaseAt.setUTCMinutes(releaseAt.getUTCMinutes() + 2);
  const hhmm = (date: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  const quiet: QuietHoursPort = {
    getSettings: async () => ({
      enabled: true,
      start: hhmm(new Date(now.getTime() - 300_000)),
      end: hhmm(releaseAt),
      timezone: "America/Chicago"
    }),
    getLocaleTimezone: async () => null
  };
  const repository = new NotificationsRepository(
    quiet,
    createNotificationPreferencePort(),
    createPushQueuePort(boss)
  );
  expect(await notify(payload, repository)).toBe("created");
  expect(await notify(payload, repository)).toBe("already_created");
  const notification = await asOwner((db) =>
    repository.findByEventKey(db, "chat", payload.idempotencyKey)
  );
  expect(notification?.deferred_until).toEqual(releaseAt);
  expect(await asOwner((db) => repository.getById(db, notification!.id))).toBeUndefined();
  const chatResult = await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    reminders.readNotificationResult(db, payload.resourceId)
  );
  expect(chatResult?.body).toBe("Reminder: check the oven");
  const jobs = await bootstrap.query(
    "SELECT data, start_after FROM pgboss.job WHERE name = 'notifications.push.summary' AND data->>'releaseAt' = $1 AND data->>'actorUserId' = $2",
    [releaseAt.toISOString(), ids.userA]
  );
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0].start_after).toEqual(releaseAt);
  expect(Object.keys(jobs.rows[0].data).sort()).toEqual([
    "actorUserId",
    "recipientUserId",
    "releaseAt"
  ]);
});

it("suppresses a current Chat mute without changing its delivered chat result", async () => {
  const payload = await due("muted reminder");
  const preferences = new PreferencesRepository();
  await asOwner((db) => preferences.upsert(db, "notifications:chat", { enabled: false }));
  try {
    expect(await notify(payload)).toBe("muted");
    expect(
      await asOwner((db) => notifications.findByEventKey(db, "chat", payload.idempotencyKey))
    ).toBeUndefined();
    expect(
      await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        reminders.readNotificationResult(db, payload.resourceId)
      )
    ).toBeDefined();
  } finally {
    await asOwner((db) => preferences.upsert(db, "notifications:chat", { enabled: true }));
  }
});

it("rechecks dismissal, acknowledgement, version and result identity before notification creation", async () => {
  const dismissed = await due("dismissed reminder");
  await asOwner(async (db) => {
    await reminders.lockForCancel(db, dismissed.resourceId);
    await reminders.dismissContext(db, dismissed.resourceId);
  });
  expect(await notify(dismissed)).toBe("inactive");
  const acknowledged = await due("acknowledged reminder");
  await asOwner(async (db) => {
    const main = await chat.getMainThread(db, ids.userA);
    await reminders.acknowledgeMain(db, main!.id, [acknowledged.idempotencyKey]);
  });
  expect(await notify({ ...acknowledged, version: 2 })).toBe("inactive");
  expect(await notify({ ...acknowledged, idempotencyKey: randomUUID() })).toBe("inactive");
  expect(await notify(acknowledged)).toBe("created");
});

it("checks source dismissal again after creation and never treats unrelated notifications as reminders", async () => {
  const payload = await due("stop further alerts");
  await notify(payload);
  const row = await asOwner((db) =>
    notifications.findByEventKey(db, "chat", payload.idempotencyKey)
  );
  const notification = await asOwner((db) => notifications.getById(db, row!.id));
  expect(
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      isReminderNotificationActive(db, notification!)
    )
  ).toBe(true);
  await asOwner(async (db) => {
    await reminders.lockForCancel(db, payload.resourceId);
    await reminders.dismissContext(db, payload.resourceId);
  });
  expect(
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      isReminderNotificationActive(db, notification!)
    )
  ).toBe(false);
  expect(
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      isReminderNotificationActive(db, { ...notification!, module_id: "tasks" })
    )
  ).toBe(true);
});

it("keeps keyed lookup, unread deferred reads and deferral inside each actor's row security", async () => {
  const payload = await due("owner-only result");
  await notify(payload);
  const row = await asOwner((db) =>
    notifications.findByEventKey(db, "chat", payload.idempotencyKey)
  );
  const releaseAt = new Date("2030-01-01T09:00:00Z");
  await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    notifications.deferDelivery(db, row!.id, releaseAt)
  );
  for (const runner of [app, worker]) {
    await runner.withDataContext({ actorUserId: ids.userB }, async (db) => {
      expect(
        await notifications.findByEventKey(db, "chat", payload.idempotencyKey)
      ).toBeUndefined();
      expect(await notifications.listUnreadDeferred(db, releaseAt)).toHaveLength(0);
      await notifications.deferDelivery(db, row!.id, new Date("2031-01-01T09:00:00Z"));
      expect(await runReminderNotificationJob(db, payload, notifications)).toBe("inactive");
    });
  }
  const own = await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    notifications.listUnreadDeferred(db, releaseAt)
  );
  expect(own.map((item) => item.id)).toContain(row!.id);
  const result = await asOwner((db) =>
    notifications.findByEventKey(db, "chat", payload.idempotencyKey)
  );
  expect(result?.deferred_until).toEqual(releaseAt);
});

it("keeps an already-visible Tasks bell item while delaying its device alert", async () => {
  const notification = await asOwner((db) =>
    notifications.create(db, {
      moduleId: "tasks",
      title: "Visible task",
      urgency: "normal",
      metadata: {},
      eventKey: randomUUID()
    })
  );
  expect(notification?.deferred_until).toBeNull();
  const now = new Date();
  const releaseAt = new Date(now);
  releaseAt.setUTCSeconds(0, 0);
  releaseAt.setUTCMinutes(releaseAt.getUTCMinutes() + 2);
  const hhmm = (date: Date) => date.toISOString().slice(11, 16);
  await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
    runPushDeliverJob(
      {
        data: {
          actorUserId: ids.userA,
          recipientUserId: ids.userA,
          notificationId: notification!.id
        }
      },
      db,
      {
        notificationsRepository: notifications,
        pushQueuePort: createPushQueuePort(boss),
        quietHoursPort: {
          getSettings: async () => ({
            enabled: true,
            start: hhmm(new Date(now.getTime() - 300_000)),
            end: hhmm(releaseAt),
            timezone: "UTC"
          }),
          getLocaleTimezone: async () => null
        }
      }
    )
  );
  const visible = await asOwner((db) => notifications.getById(db, notification!.id));
  expect(visible?.id).toBe(notification!.id);
  expect(visible?.deferred_until).toBeNull();
  const jobs = await bootstrap.query(
    "SELECT data, start_after FROM pgboss.job WHERE name = 'notifications.push.deliver' AND data->>'notificationId' = $1 AND data->>'releaseAt' = $2",
    [notification!.id, releaseAt.toISOString()]
  );
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0].start_after).toEqual(releaseAt);
  expect(jobs.rows[0].data).toEqual({
    actorUserId: ids.userA,
    recipientUserId: ids.userA,
    notificationId: notification!.id,
    releaseAt: releaseAt.toISOString()
  });
});
