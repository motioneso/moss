import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { TaskDriftRepository, TasksRepository } from "@moss/tasks";
import { connectionStrings, resetFoundationDatabase } from "./test-database.js";
import { userAContext } from "./tasks-helpers.js";

// Split out of tasks.test.ts (was pushing it over the 1000-line file-size cap). Own harness so it
// stays independently runnable — only needs a repository + a drift repository, no server/boss.
describe("TaskDriftRepository timezone awareness", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: TasksRepository;
  let driftRepository: TaskDriftRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new TasksRepository();
    driftRepository = new TaskDriftRepository();
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  it("returns a task with due_at clearly in the past as overdue (no locale set)", async () => {
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    pastDate.setUTCHours(12, 0, 0, 0);

    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        title: "TZ test — past task",
        status: "todo",
        priority: 3,
        dueAt: pastDate
      })
    );

    const overdue = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      driftRepository.getOverdue(scopedDb)
    );

    expect(overdue.some((t) => t.id === created.id)).toBe(true);
  });

  it("does not return a task with due_at clearly in the future as overdue", async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    futureDate.setUTCHours(12, 0, 0, 0);

    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        title: "TZ test — future task",
        status: "todo",
        priority: 3,
        dueAt: futureDate
      })
    );

    const overdue = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      driftRepository.getOverdue(scopedDb)
    );

    expect(overdue.some((t) => t.id === created.id)).toBe(false);
  });

  it("returns due_at at risk through the user's day-after-tomorrow boundary", async () => {
    const created = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      await scopedDb.db
        .insertInto("app.preferences")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          key: "locale",
          value_json: sql<
            Record<string, unknown>
          >`${JSON.stringify({ timezone: "America/Los_Angeles" })}::jsonb`,
          updated_at: new Date()
        })
        .onConflict((oc) =>
          oc.columns(["owner_user_id", "key"]).doUpdateSet({
            value_json: sql<
              Record<string, unknown>
            >`${JSON.stringify({ timezone: "America/Los_Angeles" })}::jsonb`,
            updated_at: new Date()
          })
        )
        .execute();
      const due = await sql<{ due_at: Date }>`
          select ((date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '2 days 23 hours 59 minutes') AT TIME ZONE 'America/Los_Angeles') as due_at
        `.execute(scopedDb.db);
      return repository.create(scopedDb, {
        title: "TZ test - LA boundary at risk",
        status: "todo",
        priority: 3,
        dueAt: due.rows[0]!.due_at
      });
    });

    const atRisk = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      driftRepository.getAtRisk(scopedDb)
    );

    expect(atRisk.some((t) => t.id === created.id)).toBe(true);
  });

  it("reads user timezone from locale preference and uses it for overdue classification", async () => {
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .insertInto("app.preferences")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          key: "locale",
          value_json: sql<
            Record<string, unknown>
          >`${JSON.stringify({ timezone: "America/Los_Angeles", region: "en-US", dateFormat: "24" })}::jsonb`,
          updated_at: new Date()
        })
        .onConflict((oc) =>
          oc.columns(["owner_user_id", "key"]).doUpdateSet({
            value_json: sql<
              Record<string, unknown>
            >`${JSON.stringify({ timezone: "America/Los_Angeles", region: "en-US", dateFormat: "24" })}::jsonb`,
            updated_at: new Date()
          })
        )
        .execute()
    );

    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    pastDate.setUTCHours(12, 0, 0, 0);

    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        title: "TZ test — LA locale past task",
        status: "todo",
        priority: 3,
        dueAt: pastDate
      })
    );

    const overdue = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      driftRepository.getOverdue(scopedDb)
    );

    expect(overdue.some((t) => t.id === created.id)).toBe(true);

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db.deleteFrom("app.preferences").where("key", "=", "locale").execute()
    );
  });
});
