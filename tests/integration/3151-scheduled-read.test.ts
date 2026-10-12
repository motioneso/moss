import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry
} from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import {
  createDatabase,
  DataContextRunner,
  SharesRepository,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { tasksModuleManifest, TasksRepository } from "@moss/tasks";
import { SettingsRepository } from "@moss/settings";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { createActiveModulesResolver } from "../../packages/module-registry/src/active-modules-resolver.js";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  registerScheduledReadWorker,
  runScheduledReadJob
} from "../../packages/chat/src/scheduled-reads/runner.js";
import { CHAT_SCHEDULED_READ_QUEUE } from "../../packages/chat/src/scheduled-reads/queue.js";
import {
  pauseReminderById,
  resumeReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { listScheduledReminders } from "../../packages/chat/src/reminders/settings.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let boss: PgBoss;
let workerBoss: PgBoss;
let bootstrap: pg.Client;
const chat = new ChatRepository();
const tasks = new TasksRepository();
function gateway(allBuiltIns = false) {
  return new AssistantToolGateway({
    confirmTimeoutMs: 0,
    runner: worker,
    repository: new AiRepository(),
    resolveActiveModules: createActiveModulesResolver({
      dataContext: worker,
      // Tasks is core today; use an optional fixture to exercise the real disable resolver.
      manifests: () =>
        allBuiltIns
          ? getBuiltInModuleManifests()
          : [
              {
                ...tasksModuleManifest,
                availability: { ...tasksModuleManifest.availability, required: false }
              }
            ]
    }),
    tokens: new SessionTokenRegistry(),
    confirmations: new ConfirmationRegistry(),
    notifier: { emit() {} }
  });
}
beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 3 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  boss = createPgBossClient(connectionStrings.app);
  workerBoss = createPgBossClient(connectionStrings.worker);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([boss.start(), workerBoss.start(), bootstrap.connect()]);
});
afterAll(async () => {
  await Promise.allSettled([
    boss?.stop({ graceful: false }),
    workerBoss?.stop({ graceful: false }),
    appDb?.destroy(),
    workerDb?.destroy(),
    bootstrap?.end()
  ]);
});
const owner = <T>(work: (db: DataContextDb) => Promise<T>) =>
  app.withDataContext({ actorUserId: ids.userA }, work);
async function save() {
  await setTasksDisabled(false);
  const task = await owner((db) => tasks.create(db, { title: `Proof ${randomUUID()}` }));
  const thread = await owner(
    async (db) =>
      (await chat.getMainThread(db, ids.userA)) ?? chat.openNewThread(db, { title: "Main" })
  );
  const persistence = new DataContextChatPersistence({
    dataContext: app,
    chatRepository: chat,
    aiRepository: new AiRepository(),
    boss
  });
  const stored = await persistence.recordReminderTurn(
    ids.userA,
    `Check task ${task.title} in 1 second`,
    {
      kind: "scheduled_read",
      taskId: task.id,
      title: task.title,
      when: { kind: "request", delaySeconds: 1, text: "check task" }
    },
    { threadId: thread.id }
  );
  if (
    !stored ||
    stored === "stopped" ||
    stored.origin.kind !== "reminder" ||
    !stored.origin.reminderId
  )
    throw new Error("check not saved");
  const id = stored.origin.reminderId;
  await bootstrap.query("BEGIN");
  await bootstrap.query("SET LOCAL session_replication_role = replica");
  await bootstrap.query(
    "UPDATE app.chat_reminders SET due_at = now() - interval '2 seconds' WHERE id = $1",
    [id]
  );
  await bootstrap.query("COMMIT");
  return {
    task,
    id,
    threadId: thread.id,
    data: { actorUserId: ids.userA, resourceId: id, version: 1 }
  };
}
function setTasksDisabled(disabled: boolean) {
  return owner((db) =>
    new SettingsRepository().setUserModuleDisabled(db, {
      moduleId: "tasks",
      actorUserId: ids.userA,
      requestId: "scheduled-read:disable-test",
      disabled
    })
  );
}
async function message(saved: Awaited<ReturnType<typeof save>>) {
  return owner(async (db) =>
    (await chat.listMessages(db, saved.threadId)).filter(
      (m) => m.role === "assistant" && m.body.includes(saved.task.title)
    )
  );
}
describe("scheduled reads through the actor worker and real gateway", () => {
  it("keeps frozen storage immutable and hides another owner's responsibility", async () => {
    const saved = await save();
    const row = await owner((db) =>
      db.db
        .selectFrom("app.chat_scheduled_reads")
        .selectAll()
        .where("reminder_id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(row).toMatchObject({
      operation: "tasks.get",
      item_id: saved.task.id,
      owner_user_id: ids.userA
    });
    expect(
      await app.withDataContext({ actorUserId: ids.userB }, (db) =>
        db.db
          .selectFrom("app.chat_scheduled_reads")
          .selectAll()
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).toEqual([]);
    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_scheduled_reads")
          .set({ item_id: randomUUID() })
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner((db) =>
        db.db
          .updateTable("app.chat_scheduled_reads")
          .set({ outcome: "success" })
          .where("reminder_id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    expect(
      await runScheduledReadJob(
        { data: { ...saved.data, actorUserId: ids.userB } },
        { dataContext: worker, gateway: gateway() }
      )
    ).toBe("inactive");
  });
  it("queues metadata, reports actual current status once and supports Settings", async () => {
    const saved = await save();
    const jobs = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
      [CHAT_SCHEDULED_READ_QUEUE, saved.id]
    );
    expect(jobs.rows.map((row) => row.data)).toEqual([saved.data]);
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    const deps = { dataContext: worker, gateway: gateway() };
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("success");
    expect(await runScheduledReadJob({ data: saved.data }, deps)).toBe("inactive");
    const messages = await message(saved);
    expect(
      messages.filter((m) => serializeMessage(m).scheduledReadSource === "tasks")
    ).toHaveLength(1);
    expect(
      messages.filter(
        (m) => m.body.includes("Its status is done") && m.body.includes("[Source: Tasks]")
      )
    ).toHaveLength(1);
    expect(
      (await owner(listScheduledReminders)).find((r) => r.id === saved.id)?.runs[0]?.message?.body
    ).toContain("Its status is done");
  });
  it("reports disabled capability as refusal without disclosing source data", async () => {
    const saved = await save();
    await setTasksDisabled(true);
    expect(
      await runScheduledReadJob({ data: saved.data }, { dataContext: worker, gateway: gateway() })
    ).toBe("refused");
    expect((await owner(listScheduledReminders)).find((r) => r.id === saved.id)).toMatchObject({
      state: "failed"
    });
    expect(
      (await owner((db) => chat.listMessages(db, saved.threadId))).filter((m) =>
        m.body.includes("access is no longer available")
      )
    ).toHaveLength(1);
    await setTasksDisabled(false);
  });
  it("denies foreign shared items at the real source guard", async () => {
    const task = await app.withDataContext({ actorUserId: ids.userB }, async (db) => {
      const item = await tasks.create(db, { title: "Foreign private title" });
      await new SharesRepository().grant(db, {
        resourceType: "task",
        resourceId: item.id,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      });
      return item;
    });
    expect(await owner((db) => tasks.getById(db, task.id))).toBeDefined();
    expect(
      await gateway().runBackgroundReadForActor(ids.userA, {
        operation: "tasks.get",
        itemId: task.id,
        runId: "foreign"
      })
    ).toMatchObject({ ok: false });
  });
  it("resume keeps read queue routing and invalidates the old version", async () => {
    const saved = await save();
    await owner((db) => pauseReminderById(db, saved.id));
    await owner((db) => resumeReminderById(db, boss, ids.userA, saved.id));
    expect(
      await runScheduledReadJob({ data: saved.data }, { dataContext: worker, gateway: gateway() })
    ).toBe("inactive");
    const jobs = await bootstrap.query(
      "SELECT name FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows.every((row) => row.name === CHAT_SCHEDULED_READ_QUEUE)).toBe(true);
  });
  it("deletion during a read prevents persistence", async () => {
    const saved = await save();
    const real = gateway();
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    expect(
      await runScheduledReadJob(
        { data: saved.data },
        {
          dataContext: worker,
          gateway: {
            async runBackgroundReadForActor(actor, read) {
              const result = await real.runBackgroundReadForActor(actor, read);
              await owner((db) => deleteReminderById(db, saved.id));
              return result;
            }
          }
        }
      )
    ).toBe("inactive");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
  });
  it("retries quietly then records exhausted failure as a normal result", async () => {
    const saved = await save();
    const deps = {
      dataContext: worker,
      gateway: {
        async runBackgroundReadForActor() {
          return { ok: false as const, error: "Tool tasks.get failed" };
        }
      }
    };
    const before = (await owner((db) => chat.listMessages(db, saved.threadId))).length;
    await expect(
      runScheduledReadJob({ data: saved.data, retryCount: 0, retryLimit: 2 }, deps)
    ).rejects.toThrow("temporarily failed");
    expect((await owner((db) => chat.listMessages(db, saved.threadId))).length).toBe(before);
    expect(
      await runScheduledReadJob({ data: saved.data, retryCount: 2, retryLimit: 2 }, deps)
    ).toBe("failed");
    expect((await owner(listScheduledReminders)).find((r) => r.id === saved.id)).toMatchObject({
      state: "failed"
    });
  });
  it("delivers through the registered queue worker and notification enqueue", async () => {
    const saved = await save();
    await owner((db) => tasks.update(db, saved.task.id, { status: "done" }));
    await registerScheduledReadWorker(workerBoss, { dataContext: worker, gateway: gateway(true) });
    const states: unknown[] = [];
    await expect
      .poll(
        async () => {
          const jobs = await bootstrap.query(
            "SELECT state, output FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
            [CHAT_SCHEDULED_READ_QUEUE, saved.id]
          );
          states.splice(0, states.length, ...jobs.rows);
          return {
            jobs: jobs.rows,
            delivered: (await message(saved)).some((m) => m.body.includes("Its status is done"))
          };
        },
        { timeout: 20_000 }
      )
      .toMatchObject({ delivered: true })
      .catch((error: unknown) => {
        throw new Error(`Queue did not deliver: ${JSON.stringify(states)}`, { cause: error });
      });
  });
});
