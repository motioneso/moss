import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import { beforeAll, afterAll } from "vitest";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry
} from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { tasksModuleManifest, TasksRepository } from "@moss/tasks";
import { SettingsRepository } from "@moss/settings";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { createActiveModulesResolver } from "../../packages/module-registry/src/active-modules-resolver.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
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
const generateReport = async (
  _actor: string,
  task: { id: string; title: string; status: string }
) => ({
  ok: true as const,
  text: `I checked ${task.title}. Its status is ${task.status}.\n\n[Source: Tasks](/tasks)`
});
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

export {
  app,
  worker,
  workerDb,
  boss,
  workerBoss,
  bootstrap,
  chat,
  tasks,
  owner,
  save,
  message,
  gateway,
  setTasksDisabled,
  generateReport
};
