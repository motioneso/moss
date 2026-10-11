import { randomUUID } from "node:crypto";
import { sql, type Insertable, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, SharesRepository, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

type ReminderInsert = Insertable<MossDatabase["app.chat_reminders"]>;
type Reminder = { id: string; thread_id: string; reserved_message_id: string; owner: string };

const repository = new ChatRepository();
const shares = new SharesRepository();
let app: Kysely<MossDatabase>;
let worker: Kysely<MossDatabase>;
let wideApp: Kysely<MossDatabase>;
let runner: DataContextRunner;
let workerRunner: DataContextRunner;
let wideRunner: DataContextRunner;

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  worker = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  wideApp = createDatabase({ connectionString: connectionStrings.app, maxConnections: 12 });
  runner = new DataContextRunner(app);
  workerRunner = new DataContextRunner(worker);
  wideRunner = new DataContextRunner(wideApp);
});

afterAll(async () => {
  await Promise.all([app?.destroy(), worker?.destroy(), wideApp?.destroy()]);
});

function mainThread(actorUserId: string) {
  return runner.withDataContext({ actorUserId }, async (db) => {
    const existing = await repository.getMainThread(db, actorUserId);
    return existing ?? repository.openNewThread(db, { title: "Main" });
  });
}

function sideThread(actorUserId: string, incognito = false) {
  return runner.withDataContext({ actorUserId }, async (db) => {
    await repository.getMainThread(db, actorUserId);
    return repository.openNewThread(db, { title: "Side", incognito });
  });
}

function message(threadId: string, actorUserId: string, role: "user" | "assistant" = "user") {
  return runner.withDataContext({ actorUserId }, (db) =>
    db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_user_id: actorUserId,
        role,
        status: "stored",
        body: "remind me in 1 minute to stretch",
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  );
}

async function createReminder(
  actorUserId: string,
  overrides: Partial<ReminderInsert> = {},
  using: DataContextRunner = runner
): Promise<Reminder> {
  const thread = await mainThread(actorUserId);
  const source = await message(thread.id, actorUserId);
  const row = await using.withDataContext({ actorUserId }, (db) =>
    db.db
      .insertInto("app.chat_reminders")
      .values({
        id: randomUUID(),
        owner_user_id: actorUserId,
        thread_id: thread.id,
        source_message_id: source.id,
        reserved_message_id: randomUUID(),
        reminder_text: "stretch",
        delay_seconds: 60,
        ...overrides
      })
      .returning(["id", "thread_id", "reserved_message_id"])
      .executeTakeFirstOrThrow()
  );
  return { ...row, owner: actorUserId };
}

function insertReserved(
  reminder: Reminder,
  overrides: Partial<Insertable<MossDatabase["app.chat_messages"]>> = {},
  actorUserId: string = reminder.owner
) {
  return workerRunner.withDataContext({ actorUserId }, (db) =>
    db.db
      .insertInto("app.chat_messages")
      .values({
        id: reminder.reserved_message_id,
        thread_id: reminder.thread_id,
        owner_user_id: actorUserId,
        role: "assistant",
        status: "stored",
        body: "Reminder: stretch",
        model_metadata: {},
        tool_metadata: {},
        ...overrides
      })
      .execute()
  );
}

function markDelivered(reminder: Reminder, actorUserId: string = reminder.owner) {
  return workerRunner.withDataContext({ actorUserId }, (db) =>
    db.db
      .updateTable("app.chat_reminders")
      .set({ state: "delivered", delivered_at: new Date(), late: false })
      .where("id", "=", reminder.id)
      .executeTakeFirst()
  );
}

function markFailed(reminder: Reminder, actorUserId: string = reminder.owner) {
  return workerRunner.withDataContext({ actorUserId }, (db) =>
    db.db
      .updateTable("app.chat_reminders")
      .set({ state: "failed" })
      .where("id", "=", reminder.id)
      .executeTakeFirst()
  );
}

async function deliver(reminder: Reminder) {
  await insertReserved(reminder);
  return markDelivered(reminder);
}

function readReminders(actorUserId: string, using: DataContextRunner = runner) {
  return using.withDataContext({ actorUserId }, (db) =>
    db.db.selectFrom("app.chat_reminders").selectAll().execute()
  );
}

describe("chat reminder row security", () => {
  it("lets the owner read a reminder and hides it from everyone else", async () => {
    const reminder = await createReminder(ids.userA);

    expect((await readReminders(ids.userA)).map((row) => row.id)).toContain(reminder.id);
    expect(await readReminders(ids.userB)).toEqual([]);
    expect(await readReminders(ids.userB, workerRunner)).toEqual([]);
  });

  it("refuses a reminder for another owner or another owner's chat", async () => {
    const own = await mainThread(ids.userA);
    const ownSource = await message(own.id, ids.userA);

    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .insertInto("app.chat_reminders")
          .values({
            id: randomUUID(),
            owner_user_id: ids.userB,
            thread_id: own.id,
            source_message_id: ownSource.id,
            reserved_message_id: randomUUID(),
            reminder_text: "stretch",
            delay_seconds: 60
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });

    const foreign = await mainThread(ids.userB);
    const foreignSource = await message(foreign.id, ids.userB);
    await runner.withDataContext({ actorUserId: ids.userB }, (db) =>
      shares.grant(db, {
        resourceType: "chat_thread",
        resourceId: foreign.id,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "manage"
      })
    );

    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .insertInto("app.chat_reminders")
          .values({
            id: randomUUID(),
            owner_user_id: ids.userA,
            thread_id: foreign.id,
            source_message_id: foreignSource.id,
            reserved_message_id: randomUUID(),
            reminder_text: "stretch",
            delay_seconds: 60
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("only saves from a user message in the owner's Main chat", async () => {
    const main = await mainThread(ids.userA);
    const side = await sideThread(ids.userA);
    const hidden = await sideThread(ids.userA, true);
    const sideSource = await message(side.id, ids.userA);
    const hiddenSource = await message(hidden.id, ids.userA);
    const assistantSource = await message(main.id, ids.userA, "assistant");

    const attempts = [
      { thread_id: side.id, source_message_id: sideSource.id },
      { thread_id: hidden.id, source_message_id: hiddenSource.id },
      { thread_id: main.id, source_message_id: assistantSource.id },
      { thread_id: main.id, source_message_id: sideSource.id }
    ];
    for (const attempt of attempts) {
      await expect(
        runner.withDataContext({ actorUserId: ids.userA }, (db) =>
          db.db
            .insertInto("app.chat_reminders")
            .values({
              id: randomUUID(),
              owner_user_id: ids.userA,
              reserved_message_id: randomUUID(),
              reminder_text: "stretch",
              delay_seconds: 60,
              ...attempt
            })
            .execute()
        )
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("sets state, version and due time from the database clock", async () => {
    const before = Date.now();
    const reminder = await createReminder(ids.userA, {
      delay_seconds: 120,
      due_at: new Date("2000-01-01T00:00:00Z"),
      state: "delivered",
      version: 7
    });
    const row = (await readReminders(ids.userA)).find((item) => item.id === reminder.id);

    expect(row).toMatchObject({ state: "queued", context_state: "pending", version: 1 });
    expect(row?.delivered_at).toBeNull();
    expect(row?.late).toBeNull();
    expect(row!.due_at.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 5_000);
    expect(row!.due_at.getTime()).toBeLessThanOrEqual(Date.now() + 120_000 + 5_000);
  });

  it("rejects text and delays outside the supported bounds", async () => {
    for (const overrides of [
      { reminder_text: "" },
      { reminder_text: "   " },
      { reminder_text: "x".repeat(501) },
      { delay_seconds: 0 },
      { delay_seconds: 2_592_001 }
    ]) {
      await expect(createReminder(ids.userA, overrides)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("saves one reminder per source message and per reserved message", async () => {
    const reminder = await createReminder(ids.userA);
    const row = (await readReminders(ids.userA)).find((item) => item.id === reminder.id)!;

    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .insertInto("app.chat_reminders")
          .values({
            id: randomUUID(),
            owner_user_id: ids.userA,
            thread_id: row.thread_id,
            source_message_id: row.source_message_id,
            reserved_message_id: randomUUID(),
            reminder_text: "stretch",
            delay_seconds: 60
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      createReminder(ids.userA, { reserved_message_id: row.reserved_message_id })
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("does not let the app change or delete a reminder, or the worker create one", async () => {
    const reminder = await createReminder(ids.userA);

    // #3310: the app may write only state and context, so a text change is refused outright.
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ reminder_text: "changed" })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db.deleteFrom("app.chat_reminders").where("id", "=", reminder.id).execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(createReminder(ids.userA, {}, workerRunner)).rejects.toMatchObject({
      code: "42501"
    });
  });
});

describe("chat reminder worker permissions", () => {
  it("refuses every chat message except the reserved assistant reply", async () => {
    const reminder = await createReminder(ids.userA);
    const side = await sideThread(ids.userA);

    for (const overrides of [
      { role: "user" as const },
      { status: "pending" as const },
      { id: randomUUID() },
      { thread_id: side.id }
    ]) {
      await expect(insertReserved(reminder, overrides)).rejects.toMatchObject({ code: "42501" });
    }

    // Another owner cannot even see the thread, so the thread trigger refuses first.
    await expect(insertReserved(reminder, {}, ids.userB)).rejects.toThrow(
      /chat message thread does not exist|row-level security/
    );
  });

  it("delivers once and refuses every second write", async () => {
    const reminder = await createReminder(ids.userA);

    expect(Number((await deliver(reminder)).numUpdatedRows)).toBe(1);
    await expect(insertReserved(reminder)).rejects.toMatchObject({ code: "42501" });
    expect(Number((await markDelivered(reminder)).numUpdatedRows)).toBe(0);

    const messages = await runner.withDataContext({ actorUserId: ids.userA }, (db) =>
      db.db
        .selectFrom("app.chat_messages")
        .select("id")
        .where("id", "=", reminder.reserved_message_id)
        .execute()
    );
    expect(messages).toHaveLength(1);
  });

  it("refuses delivery without the reserved message or for another owner", async () => {
    const reminder = await createReminder(ids.userA);

    await expect(markDelivered(reminder)).rejects.toThrow(/needs its reserved message/);
    expect(Number((await markDelivered(reminder, ids.userB)).numUpdatedRows)).toBe(0);
  });

  it("refuses any change other than delivery", async () => {
    const reminder = await createReminder(ids.userA);
    await insertReserved(reminder);

    await expect(
      workerRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "delivered", delivered_at: new Date(), late: false, reminder_text: "x" })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toThrow(/identity cannot be changed/);
    await expect(
      workerRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ due_at: new Date() })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toThrow();
  });

  it("marks an undeliverable reminder failed once, with no message and no way back", async () => {
    const reminder = await createReminder(ids.userA);

    expect(Number((await markFailed(reminder, ids.userB)).numUpdatedRows)).toBe(0);
    expect(Number((await markFailed(reminder)).numUpdatedRows)).toBe(1);
    expect(Number((await markFailed(reminder)).numUpdatedRows)).toBe(0);
    await expect(insertReserved(reminder)).rejects.toMatchObject({ code: "42501" });
    expect(Number((await markDelivered(reminder)).numUpdatedRows)).toBe(0);

    const row = (await readReminders(ids.userA)).find((item) => item.id === reminder.id);
    expect(row).toMatchObject({ state: "failed", delivered_at: null, late: null });
  });

  it("refuses a failed reminder that carries delivery details", async () => {
    const reminder = await createReminder(ids.userA);

    await expect(
      workerRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "failed", delivered_at: new Date(), late: false })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("does not let the app mark a reminder failed", async () => {
    const reminder = await createReminder(ids.userA);

    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "failed" })
          .where("id", "=", reminder.id)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot delete reminders or chat messages", async () => {
    const reminder = await createReminder(ids.userA);
    await deliver(reminder);

    await expect(
      workerRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db.deleteFrom("app.chat_reminders").where("id", "=", reminder.id).execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      workerRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
        db.db
          .deleteFrom("app.chat_messages")
          .where("id", "=", reminder.reserved_message_id)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("chat reminder capacity", () => {
  it("holds 20 open reminders, keeps delivered ones counted, and frees failed ones", async () => {
    const saved: Reminder[] = [];
    for (let index = 0; index < 20; index += 1) {
      saved.push(await createReminder(ids.userC));
    }

    await expect(createReminder(ids.userC)).rejects.toThrow(/chat_reminder_capacity_reached/);
    await deliver(saved[0]!);
    await expect(createReminder(ids.userC)).rejects.toThrow(/chat_reminder_capacity_reached/);

    await markFailed(saved[1]!);
    await expect(createReminder(ids.userC)).resolves.toMatchObject({ owner: ids.userC });
    await expect(createReminder(ids.userC)).rejects.toThrow(/chat_reminder_capacity_reached/);
  });

  it("admits only the free slots under concurrent saves", async () => {
    for (let index = 0; index < 18; index += 1) {
      await createReminder(ids.userD);
    }
    const thread = await mainThread(ids.userD);
    const sources = await Promise.all(
      Array.from({ length: 10 }, () => message(thread.id, ids.userD))
    );

    const results = await Promise.allSettled(
      sources.map((source) =>
        wideRunner.withDataContext({ actorUserId: ids.userD }, async (db) => {
          await sql`select pg_sleep(0.05)`.execute(db.db);
          return db.db
            .insertInto("app.chat_reminders")
            .values({
              id: randomUUID(),
              owner_user_id: ids.userD,
              thread_id: thread.id,
              source_message_id: source.id,
              reserved_message_id: randomUUID(),
              reminder_text: "stretch",
              delay_seconds: 60
            })
            .execute();
        })
      )
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(await readReminders(ids.userD)).toHaveLength(20);
  });
});
