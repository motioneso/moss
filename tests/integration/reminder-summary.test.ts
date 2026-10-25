import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import pg from "pg";
import { createDatabase, DataContextRunner, type DataContextDb } from "@moss/db";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { readReminderSummary } from "../../packages/chat/src/reminders/summary/repository.js";
import { readReminderSummarySnapshot } from "../../packages/chat/src/reminders/summary/contract.js";
import { reminderSummaryExecute } from "../../packages/chat/src/reminders/summary/tool.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { reminderNow } from "../fixtures/reminder-summary.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

type When = Parameters<ReminderRepository["create"]>[1]["when"];

describe("Reminder summary actor-scoped persisted reads", () => {
  const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  const runner = new DataContextRunner(appDb);
  const reminders = new ReminderRepository();
  const chat = new ChatRepository();
  const now = new Date(reminderNow);
  const as = <T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) =>
    runner.withDataContext({ actorUserId, requestId: "reminder-summary" }, work);
  const saved: Record<string, string> = {};

  async function save(
    actor: string,
    text: string,
    opts: { when?: When; destinationTitle?: string } = {}
  ) {
    return as(actor, async (db) => {
      const thread =
        (await chat.getMainThread(db, actor)) ?? (await chat.openNewThread(db, { title: "Main" }));
      const source = await db.db
        .insertInto("app.chat_messages")
        .values({
          id: randomUUID(),
          thread_id: thread.id,
          owner_user_id: actor,
          role: "user",
          status: "stored",
          body: text,
          model_metadata: {},
          tool_metadata: {}
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const r = await reminders.create(db, {
        threadId: thread.id,
        sourceMessageId: source.id,
        text,
        when: opts.when ?? { timing: "relative", delaySeconds: 3600 },
        destinationTitle: opts.destinationTitle ?? null
      });
      saved[text] = r.id;
      return r;
    });
  }
  async function force(statement: string, params: unknown[]) {
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(statement, params);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  }
  beforeAll(async () => {
    await resetFoundationDatabase();
    await save(ids.userA, "Water plants");
    await save(ids.userA, "Stretch", {
      when: { timing: "relative", delaySeconds: 600, repeat: { kind: "interval", seconds: 3600 } }
    });
    await save(ids.userA, "Old cancelled");
    await save(ids.userA, "Old delivered", { destinationTitle: "Errands" });
    await save(ids.userB, "User B secret");
    await force(`UPDATE app.chat_reminders SET state='cancelled' WHERE id=$1`, [
      saved["Old cancelled"]
    ]);
    await force(
      `UPDATE app.chat_reminders SET state='delivered', delivered_at=now(), late=false, context_state='dismissed' WHERE id=$1`,
      [saved["Old delivered"]]
    );
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  it("returns only the actor's reminders per scope, keeping lifecycle and dismissal apart", async () => {
    const read = (scope: Parameters<typeof readReminderSummary>[1]) =>
      as(ids.userA, (db) => readReminderSummary(db, scope, now));
    expect((await read("upcoming")).items.map((i) => i.text).sort()).toEqual([
      "Stretch",
      "Water plants"
    ]);
    const delivered = (await read("delivered")).items;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      text: "Old delivered",
      state: "delivered",
      contextState: "dismissed",
      destinationTitle: "Errands",
      late: false
    });
    expect((await read("ended")).items.map((i) => i.text)).toEqual(["Old cancelled"]);
    const all = await read("all");
    expect(all.items).toHaveLength(4);
    expect(all.items.map((i) => i.text)).not.toContain("User B secret");
    expect(all.items.find((i) => i.text === "Stretch")?.repeat).toEqual({
      kind: "interval",
      seconds: 3600
    });
    expect(readReminderSummarySnapshot({})).toBeNull();
  });
  it("denies another user's reminders and the admin's view of private ones", async () => {
    const admin = await as(ids.adminUser, (db) => readReminderSummary(db, "all", now));
    expect(admin.items).toEqual([]);
    const b = await as(ids.userB, (db) => readReminderSummary(db, "all", now));
    expect(b.items.map((i) => i.text)).toEqual(["User B secret"]);
  });
  it("writes nothing: works in a read-only transaction and leaves every stored byte unchanged", async () => {
    await as(ids.userA, async (db) => {
      await sql`set local transaction_read_only = on`.execute(db.db);
      const before = await db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .orderBy("id")
        .execute();
      await readReminderSummary(db, "all", now);
      const ctx = { actorUserId: ids.userA, requestId: "r", chatSessionId: "s" };
      await reminderSummaryExecute(db, { scope: "all" }, ctx, {
        visualPresentation: new VisualPresentationService()
      });
      const after = await db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .orderBy("id")
        .execute();
      expect(after).toEqual(before);
    });
  });
  it("reports twelve rows and honest truncation", async () => {
    for (let n = 0; n < 14; n++) await save(ids.userA, `Extra ${n}`);
    const partial = await as(ids.userA, (db) => readReminderSummary(db, "upcoming", now));
    expect(partial.items).toHaveLength(12);
    expect(partial.truncated).toBe(true);
  });
  it("negative control: the admin-denial assertion fails when the SELECT policy is bypassed", async () => {
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE jarvis_app_runtime");
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [ids.adminUser]);
      expect((await client.query("SELECT id FROM app.chat_reminders")).rows).toEqual([]);
      await client.query("RESET ROLE");
      await client.query(
        "CREATE POLICY summary_negative_control ON app.chat_reminders FOR SELECT TO jarvis_app_runtime USING (true)"
      );
      await client.query("SET LOCAL ROLE jarvis_app_runtime");
      const unguarded = (await client.query("SELECT id FROM app.chat_reminders")).rows;
      expect(() => expect(unguarded).toEqual([])).toThrow();
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
    expect((await as(ids.adminUser, (db) => readReminderSummary(db, "all", now))).items).toEqual(
      []
    );
  });
});
