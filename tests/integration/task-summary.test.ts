import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import pg from "pg";
import { createDatabase, DataContextRunner, SharesRepository } from "@moss/db";
import { TasksRepository } from "@moss/tasks";
import { readTaskSummary } from "../../packages/tasks/src/summary/repository.js";
import { taskSummaryExecute } from "../../packages/tasks/src/summary/tool.js";
import { readTaskSummarySnapshot } from "../../packages/tasks/src/summary/contract.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { summaryNow } from "../fixtures/task-summary.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { seedTaskData, taskIds, userAContext, userBContext } from "./tasks-helpers.js";

describe("Tasks summary actor-scoped persisted reads", () => {
  const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  const runner = new DataContextRunner(appDb);
  const tasks = new TasksRepository();
  const now = new Date(summaryNow);
  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedTaskData();
  });
  afterAll(async () => {
    await appDb.destroy();
  });
  it("includes explicit task shares and denies private tasks even to admins", async () => {
    const readA = await runner.withDataContext(userAContext(), (db) =>
      readTaskSummary(db, "all", now)
    );
    expect(readA.items.map((t) => t.id)).toEqual([taskIds.aPrivate]);
    await runner.withDataContext(userBContext(), (db) =>
      new SharesRepository().grant(db, {
        resourceType: "task",
        resourceId: taskIds.bPrivate,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );
    const shared = await runner.withDataContext(userAContext(), (db) =>
      readTaskSummary(db, "all", now)
    );
    expect(shared.items.map((t) => t.id).sort()).toEqual([taskIds.aPrivate, taskIds.bPrivate]);
    const admin = await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "summary-admin" },
      (db) => readTaskSummary(db, "all", now)
    );
    expect(admin.items).toEqual([]);
  });
  it("never reconciles stale recurrence, succeeds in a read-only transaction and preserves every stored byte", async () => {
    await runner.withDataContext(userAContext(), async (db) => {
      await sql`update app.tasks set recurrence = ${JSON.stringify({ series_id: "50000000-0000-4000-8000-000000000001", frequency: "daily", interval: 1, occurrence_date: "2026-01-01" })}::jsonb, due_at = '2026-01-01T20:00:00Z' where id = ${taskIds.aPrivate}`.execute(
        db.db
      );
    });
    await runner.withDataContext(userAContext(), async (db) => {
      await sql`set local transaction_read_only = on`.execute(db.db);
      const before = await db.db.selectFrom("app.tasks").selectAll().orderBy("id").execute();
      const read = await readTaskSummary(db, "today", now);
      expect(read.items.find((t) => t.id === taskIds.aPrivate)).toMatchObject({
        recurring: true,
        dueAt: "2026-01-01T20:00:00.000Z",
        dueState: "overdue"
      });
      const after = await db.db.selectFrom("app.tasks").selectAll().orderBy("id").execute();
      expect(after).toEqual(before);
    });
  });
  it("filters local-day boundaries and states, and reports twelve-row lookahead truthfully", async () => {
    const items = [
      { title: "Yesterday", dueAt: "2026-10-23T06:59:59Z" },
      { title: "Today", dueAt: "2026-10-24T06:59:59Z" },
      { title: "Tomorrow", dueAt: "2026-10-24T07:00:00Z" },
      { title: "Finished", status: "done" as const, dueAt: "2026-10-23T19:00:00Z" },
      { title: "Archived", status: "archived" as const },
      { title: "Suggested", status: "suggested" as const }
    ];
    for (const input of items)
      await runner.withDataContext(userAContext(), (db) => tasks.create(db, input));
    const read = async (scope: Parameters<typeof readTaskSummary>[1]) =>
      runner.withDataContext(userAContext(), (db) => readTaskSummary(db, scope, now));
    expect((await read("upcoming")).items.map((t) => t.title)).toEqual(["Tomorrow"]);
    expect((await read("completed")).items.map((t) => t.title)).toEqual(["Finished"]);
    expect((await read("overdue")).items.map((t) => t.title)).toContain("Yesterday");
    expect((await read("today")).items.map((t) => t.title)).toContain("Today");
    expect((await read("today")).items.map((t) => t.title)).not.toContain("Finished");
    expect((await read("undated")).items.map((t) => t.title).sort()).toEqual([
      "User B seeded private task"
    ]);
    for (let n = 0; n < 15; n++)
      await runner.withDataContext(userAContext(), (db) =>
        tasks.create(db, { title: `Undated ${n}` })
      );
    const partial = await read("undated");
    expect(partial.items).toHaveLength(12);
    expect(partial.truncated).toBe(true);
  });
  it("registers only through the current actor/turn and preserves source-bound fallback", async () => {
    const ctx = { ...userAContext(), requestId: "summary-test", chatSessionId: "test-session" };
    const visual = new VisualPresentationService();
    // The service's admission supplies actor/thread/turn scope; outside it the read has no visual authority.
    const result = await runner.withDataContext(ctx, (db) =>
      taskSummaryExecute(db, { scope: "completed" }, ctx, { visualPresentation: visual })
    );
    expect(result.data).toHaveProperty("summary");
    expect(result.data).not.toHaveProperty("presentation");
    expect(readTaskSummarySnapshot({})).toBeNull();
  });
  it("negative control: the same admin-denial assertion fails when SELECT policy is bypassed, then protection returns", async () => {
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE jarvis_app_runtime");
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [ids.adminUser]);
      expect((await client.query("SELECT id FROM app.tasks")).rows).toEqual([]);
      await client.query("RESET ROLE");
      await client.query(
        "CREATE POLICY summary_negative_control ON app.tasks FOR SELECT TO jarvis_app_runtime USING (true)"
      );
      await client.query("SET LOCAL ROLE jarvis_app_runtime");
      const unguarded = (await client.query("SELECT id FROM app.tasks")).rows;
      expect(() => expect(unguarded).toEqual([])).toThrow();
      console.log(
        "[negative-control] identical admin-denial assertion failed with permissive SELECT policy"
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
    expect(
      (
        await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "restored" }, (db) =>
          readTaskSummary(db, "all", now)
        )
      ).items
    ).toEqual([]);
  });
});
