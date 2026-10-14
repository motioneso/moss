import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { resolveReminderDestination } from "../../packages/chat/src/reminders/destination.js";
import { decideReminderTurn } from "../../packages/chat/src/reminders/turn.js";
import { editReminderById } from "../../packages/chat/src/reminders/edit.js";
import { deliverDueReminder } from "../../packages/chat/src/reminders/deliver.js";
import { readReminderRuns } from "../../packages/chat/src/reminders/runs.js";
import { runScheduledReadJob } from "../../packages/chat/src/scheduled-reads/runner.js";
import { saveScheduledOperation } from "../../packages/chat/src/scheduled-reads/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const chat = new ChatRepository();
const reminders = new ReminderRepository();
const boss = { send: vi.fn(async () => randomUUID()) };
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let bootstrap: pg.Client;
beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});
afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), workerDb?.destroy(), bootstrap?.end()]);
});
const owner = <T>(work: (db: DataContextDb) => Promise<T>, actorUserId: string = ids.userA) =>
  app.withDataContext({ actorUserId }, work);
async function side(title: string, actorUserId: string = ids.userA, incognito = false) {
  return owner(async (db) => {
    if (!(await chat.getMainThread(db, actorUserId)))
      await chat.openNewThread(db, { title: "Main" });
    return chat.openNewThread(db, { title, incognito });
  }, actorUserId);
}
async function save(
  sourceThreadId: string,
  destination?: string,
  actorUserId: string = ids.userA,
  repeat = false
) {
  return owner(async (db) => {
    const thread = (await chat.getOwnedThreadById(db, actorUserId, sourceThreadId))!;
    const decision = await decideReminderTurn(
      db,
      {
        reminders,
        boss,
        locale: async () => ({ timeZone: "UTC", clockFormat: "24" })
      },
      actorUserId,
      thread,
      {
        ...(repeat
          ? {
              kind: "repeat_request" as const,
              repeat: { kind: "interval" as const, seconds: 60 },
              clock: null,
              weekday: null
            }
          : { kind: "request" as const, delaySeconds: 60 }),
        text: "destination proof",
        ...(destination ? { destination } : {})
      }
    );
    expect(decision.origin.event).toBe("saved");
    const source = await db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: thread.id,
        owner_user_id: actorUserId,
        role: "user",
        status: "stored",
        body: "remind me in 1 minute to destination proof",
        model_metadata: {},
        tool_metadata: {}
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await decision.save!(source.id);
    return db.db
      .selectFrom("app.chat_reminders")
      .selectAll()
      .where("id", "=", decision.origin.reminderId!)
      .executeTakeFirstOrThrow();
  }, actorUserId);
}
async function due(id: string) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = now() - interval '1 second' WHERE id = $1",
      [id]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}
function deliver(id: string, version: number, actorUserId: string = ids.userA) {
  return worker.withDataContext({ actorUserId }, (db) =>
    deliverDueReminder(db, { resourceId: id, version, actorUserId }, { chat, reminders, boss })
  );
}

describe("owned task destinations", () => {
  it("defaults to Main from a side chat and persists explicit side results once", async () => {
    const source = await side("Travel");
    const defaultTask = await save(source.id);
    const explicit = await save(source.id, "this chat");
    expect(defaultTask.thread_id).not.toBe(source.id);
    expect(defaultTask.destination_title).toBeNull();
    expect(explicit.thread_id).toBe(source.id);
    expect(explicit.destination_title).toBe("Travel");
    await due(explicit.id);
    expect(await deliver(explicit.id, explicit.version)).toBe("delivered");
    expect(await deliver(explicit.id, explicit.version)).toBe("already_delivered");
    const message = await owner((db) => chat.getMessageById(db, explicit.reserved_message_id));
    expect(message?.thread_id).toBe(source.id);
    expect(message?.body).toBe("Reminder: destination proof");
  });
  it.each(["available", "deleted", "foreign"])(
    "checks a saved source task with destination %s",
    async (availability) => {
      const target = await side(`Source check ${availability}`);
      const saved = await save(target.id);
      const itemId = randomUUID();
      await owner((db) => saveScheduledOperation(db, saved.id, itemId));
      const edited = await owner((db) =>
        editReminderById(
          db,
          boss,
          ids.userA,
          saved.id,
          saved.version,
          {
            text: null,
            delaySeconds: null,
            localDue: null,
            deadline: "keep",
            localDeadline: null,
            destination: target.title
          },
          "UTC",
          target.id
        )
      );
      expect(edited.kind).toBe("changed");
      if (availability === "deleted")
        await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
      if (availability === "foreign") {
        // Ownership is immutable in production; this fixture represents a revoked target.
        await bootstrap.query("BEGIN");
        try {
          await bootstrap.query("SET LOCAL session_replication_role = replica");
          await bootstrap.query("UPDATE app.chat_threads SET owner_user_id = $1 WHERE id = $2", [
            ids.userB,
            target.id
          ]);
          await bootstrap.query("COMMIT");
        } catch (error) {
          await bootstrap.query("ROLLBACK");
          throw error;
        }
      }
      await due(saved.id);
      const read = vi.fn(async () => ({
        ok: true as const,
        data: {},
        structuredData: { task: { id: itemId, title: "Destination source", status: "done" } }
      }));
      const result = await runScheduledReadJob(
        {
          data: {
            actorUserId: ids.userA,
            resourceId: saved.id,
            version: saved.version + 1
          }
        },
        {
          dataContext: worker,
          gateway: { runBackgroundReadForActor: read },
          generateReport: async () => ({
            ok: true,
            text: "I checked Destination source. Its status is done.\n\n[Source: Tasks](/tasks)"
          })
        }
      );
      expect(result).toBe(availability === "available" ? "success" : "inactive");
      expect(read).toHaveBeenCalledTimes(availability === "available" ? 2 : 0);
      const messages = await bootstrap.query(
        "SELECT thread_id, body FROM app.chat_messages WHERE id = $1",
        [saved.reserved_message_id]
      );
      expect(messages.rows).toEqual(
        availability === "available"
          ? [
              {
                thread_id: target.id,
                body: "I checked Destination source. Its status is done.\n\n[Source: Tasks](/tasks)"
              }
            ]
          : []
      );
      expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe(
        availability === "available" ? "delivered" : "failed"
      );
      if (availability === "foreign")
        expect(
          await owner((db) => chat.getMessageById(db, saved.reserved_message_id), ids.userB)
        ).toBeUndefined();
    }
  );
  it.each(["deleted", "foreign"])(
    "posts nothing when the destination becomes %s immediately before posting",
    async (availability) => {
      const target = await side(`Lost during run ${availability}`);
      const saved = await save(target.id, "this chat");
      const itemId = randomUUID();
      await owner((db) => saveScheduledOperation(db, saved.id, itemId));
      await due(saved.id);
      let reads = 0;
      const read = async () => {
        reads += 1;
        if (reads === 2) {
          if (availability === "deleted")
            await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
          else {
            // Ownership is immutable in production; represent revocation in the fixture.
            await bootstrap.query("BEGIN");
            try {
              await bootstrap.query("SET LOCAL session_replication_role = replica");
              await bootstrap.query(
                "UPDATE app.chat_threads SET owner_user_id = $1 WHERE id = $2",
                [ids.userB, target.id]
              );
              await bootstrap.query("COMMIT");
            } catch (error) {
              await bootstrap.query("ROLLBACK");
              throw error;
            }
          }
        }
        return {
          ok: true as const,
          data: {},
          structuredData: { task: { id: itemId, title: "Destination source", status: "done" } }
        };
      };
      expect(
        await runScheduledReadJob(
          { data: { actorUserId: ids.userA, resourceId: saved.id, version: saved.version } },
          {
            dataContext: worker,
            gateway: { runBackgroundReadForActor: read },
            generateReport: async () => ({ ok: true, text: "Private report must be discarded" })
          }
        )
      ).toBe("inactive");
      expect(reads).toBe(2);
      expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe("failed");
      const messages = await bootstrap.query("SELECT id FROM app.chat_messages WHERE id = $1", [
        saved.reserved_message_id
      ]);
      expect(messages.rows).toEqual([]);
      expect(
        await owner((db) => chat.getMessageById(db, saved.reserved_message_id), ids.userB)
      ).toBeUndefined();
    }
  );
  it("advances side repeats and validates the destination again on the next firing", async () => {
    const target = await side("Repeating target");
    const saved = await save(target.id, "this chat", ids.userA, true);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("delivered");
    const next = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(next.version).toBe(saved.version + 1);
    expect(next.repeat_kind).toBe("interval");
    expect(next.thread_id).toBe(target.id);
    expect(next.reserved_message_id).not.toBe(saved.reserved_message_id);
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
    await due(saved.id);
    expect(await deliver(saved.id, next.version)).toBe("destination_unavailable");
    expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe("failed");
  });
  it.each(["Main to side", "side to Main"])(
    "keeps delivered occurrences in their original chat after a %s edit",
    async (direction) => {
      const target = await side(`Historical ${direction}`);
      const main = (await owner((db) => chat.getMainThread(db, ids.userA)))!;
      const originalThread = direction === "Main to side" ? main : target;
      const futureThread = direction === "Main to side" ? target : main;
      const saved = await save(originalThread.id, "this chat", ids.userA, true);
      await due(saved.id);
      expect(await deliver(saved.id, saved.version)).toBe("delivered");
      const originalMessage = await owner((db) =>
        chat.getMessageById(db, saved.reserved_message_id)
      );
      const edited = await owner((db) =>
        editReminderById(
          db,
          boss,
          ids.userA,
          saved.id,
          saved.version + 1,
          {
            text: null,
            delaySeconds: null,
            localDue: null,
            deadline: "keep",
            localDeadline: null,
            destination: futureThread.is_main ? "Main" : futureThread.title
          },
          "UTC",
          originalThread.id
        )
      );
      expect(edited.kind).toBe("changed");
      expect(await owner((db) => chat.getMessageById(db, saved.reserved_message_id))).toEqual(
        originalMessage
      );
      const occurrence = {
        id: saved.reserved_message_id,
        threadId: originalThread.id,
        body: "Reminder: destination proof"
      };
      expect((await owner((db) => readReminderRuns(db, saved.id)))[0]?.message).toEqual(occurrence);
      expect(
        await owner((db) => reminders.readNotificationResult(db, saved.id, occurrence.id))
      ).toEqual({
        ownerUserId: ids.userA,
        version: saved.version,
        messageId: occurrence.id,
        body: occurrence.body
      });
      const pending = await owner((db) => reminders.listPendingMain(db, originalThread.id, 20));
      expect(pending.map((row) => row.reservedMessageId)).toContain(occurrence.id);
      expect(
        (await owner((db) => reminders.listPendingMain(db, futureThread.id, 20))).some(
          (row) => row.reservedMessageId === occurrence.id
        )
      ).toBe(false);
      expect(await owner((db) => readReminderRuns(db, saved.id), ids.userB)).toEqual([]);
      expect(
        await owner(
          (db) => reminders.readNotificationResult(db, saved.id, occurrence.id),
          ids.userB
        )
      ).toBeUndefined();
      await owner(
        (db) => reminders.acknowledgeMain(db, originalThread.id, [occurrence.id]),
        ids.userB
      );
      await owner((db) => reminders.acknowledgeMain(db, futureThread.id, [occurrence.id]));
      expect(await owner((db) => reminders.listPendingMain(db, originalThread.id, 20))).toEqual(
        pending
      );
      await owner((db) => reminders.acknowledgeMain(db, originalThread.id, [occurrence.id]));
      expect(
        (await owner((db) => reminders.listPendingMain(db, originalThread.id, 20))).some(
          (row) => row.reservedMessageId === occurrence.id
        )
      ).toBe(false);
      const next = await owner((db) =>
        db.db
          .selectFrom("app.chat_reminders")
          .selectAll()
          .where("id", "=", saved.id)
          .executeTakeFirstOrThrow()
      );
      await due(saved.id);
      expect(await deliver(saved.id, next.version)).toBe("delivered");
      const runs = await owner((db) => readReminderRuns(db, saved.id));
      expect(runs.find((run) => run.message?.id === occurrence.id)?.message).toEqual(occurrence);
      expect(
        runs.find((run) => run.message?.id === next.reserved_message_id)?.message?.threadId
      ).toBe(futureThread.id);
      await owner((db) =>
        db.db.deleteFrom("app.chat_reminders").where("id", "=", saved.id).execute()
      );
    }
  );
  it.each(["advancement", "destination"])(
    "observes the %s update guard fail when removed, then restores it",
    async (guard) => {
      const target = await side(`Guard ${guard}`);
      const saved = await save(target.id, "this chat", ids.userA, guard === "advancement");
      if (guard === "advancement") await due(saved.id);
      const attempt = () =>
        (guard === "advancement" ? worker : app).withDataContext(
          { actorUserId: ids.userA },
          async (db) => {
            await db.db
              .updateTable("app.chat_reminders")
              .set(
                guard === "advancement"
                  ? {
                      version: saved.version + 1,
                      reserved_message_id: randomUUID(),
                      due_at: sql<Date>`due_at + interval '60 seconds'`
                    }
                  : {
                      version: saved.version + 1,
                      thread_id: randomUUID(),
                      destination_title: "Missing"
                    }
              )
              .where("id", "=", saved.id)
              .execute();
            // Roll back the deliberately accepted mutation so restoration sees the original row.
            throw new Error("guard absent");
          }
        );
      const expected = guard === "advancement" ? /persisted run/ : /destination is unavailable/;
      await expect(attempt()).rejects.toThrow(expected);
      const definition = (
        await bootstrap.query(
          "SELECT pg_get_functiondef('app.enforce_chat_reminder_update()'::regprocedure) AS definition"
        )
      ).rows[0]!.definition as string;
      const removed =
        guard === "destination"
          ? definition.replace(
              "      PERFORM app.check_chat_reminder_destination(NEW.owner_user_id, NEW.thread_id, NEW.destination_title);",
              "      NULL;"
            )
          : definition.slice(
              0,
              definition.indexOf("      OR NOT EXISTS (SELECT 1 FROM app.chat_reminder_runs run")
            ) +
            definition.slice(
              definition.indexOf(
                " THEN\n      RAISE EXCEPTION 'chat reminder advancement needs its persisted run'"
              )
            );
      expect(removed).not.toBe(definition);
      try {
        await bootstrap.query(removed);
        await expect(attempt()).rejects.toThrow("guard absent");
      } finally {
        await bootstrap.query(definition);
      }
      await expect(attempt()).rejects.toThrow(expected);
    }
  );
  it("destination-only edits preserve time/text and invalidate the old queued version", async () => {
    const source = await side("Route source");
    const target = await side("Route target");
    const saved = await save(source.id);
    const result = await owner((db) =>
      editReminderById(
        db,
        boss,
        ids.userA,
        saved.id,
        saved.version,
        {
          text: null,
          delaySeconds: null,
          localDue: null,
          deadline: "keep",
          localDeadline: null,
          destination: "Route target"
        },
        "UTC",
        source.id
      )
    );
    expect(result.kind).toBe("changed");
    const changed = await owner((db) =>
      db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(changed.thread_id).toBe(target.id);
    expect(changed.version).toBe(saved.version + 1);
    expect(changed.due_at).toEqual(saved.due_at);
    expect(changed.reminder_text).toBe(saved.reminder_text);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("stale_version");
    expect(await deliver(saved.id, changed.version)).toBe("delivered");
  });
  it.each([false, true])(
    "keeps paused edits and acknowledges exact side delivery, repeat=%s",
    async (repeat) => {
      const source = await side(`Paused source ${repeat}`);
      const target = await side(`Paused target ${repeat}`);
      const saved = await save(source.id);
      await owner((db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ state: "paused", version: saved.version + 1 })
          .where("id", "=", saved.id)
          .execute()
      );
      const beforeJobs = boss.send.mock.calls.length;
      const edited = await owner((db) =>
        editReminderById(
          db,
          boss,
          ids.userA,
          saved.id,
          saved.version + 1,
          {
            text: null,
            delaySeconds: null,
            localDue: null,
            deadline: "keep",
            localDeadline: null,
            destination: target.title
          },
          "UTC",
          source.id
        )
      );
      expect(edited.kind).toBe("changed");
      expect(boss.send.mock.calls.length).toBe(beforeJobs);
      expect(await deliver(saved.id, saved.version + 2)).toBe("paused");
      const delivered = await save(target.id, "this chat", ids.userA, repeat);
      await due(delivered.id);
      expect(await deliver(delivered.id, delivered.version)).toBe("delivered");
      expect(await owner((db) => reminders.listPendingMain(db, source.id, 20))).toEqual([]);
      const pending = await owner((db) => reminders.listPendingMain(db, target.id, 20));
      expect(pending.map((row) => row.reservedMessageId)).toContain(delivered.reserved_message_id);
      const main = await owner((db) => chat.getMainThread(db, ids.userA));
      expect(
        (await owner((db) => reminders.listPendingMain(db, main!.id, 20))).some(
          (row) => row.reservedMessageId === delivered.reserved_message_id
        )
      ).toBe(false);
      expect(await owner((db) => reminders.listPendingMain(db, target.id, 20), ids.userB)).toEqual(
        []
      );
      await owner((db) =>
        reminders.acknowledgeMain(db, source.id, [delivered.reserved_message_id])
      );
      expect(await owner((db) => reminders.listPendingMain(db, target.id, 20))).toEqual(pending);
      await owner((db) =>
        reminders.acknowledgeMain(db, target.id, [delivered.reserved_message_id])
      );
      expect(await owner((db) => reminders.listPendingMain(db, target.id, 20))).toEqual([]);
    }
  );
  it("refuses a foreign destination even if the thread ownership invariant is bypassed", async () => {
    const target = await side("Ownership changed");
    const saved = await save(target.id, "this chat");
    // Production forbids ownership changes; only this isolated fixture bypasses that invariant.
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await bootstrap.query("UPDATE app.chat_threads SET owner_user_id = $1 WHERE id = $2", [
        ids.userB,
        target.id
      ]);
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK");
      throw error;
    }
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("destination_unavailable");
    expect(await owner((db) => chat.getMessageById(db, saved.reserved_message_id))).toBeUndefined();
    expect((await owner((db) => reminders.readState(db, saved.id)))?.state).toBe("failed");
  });
  it("refuses foreign, private, missing and ambiguous names", async () => {
    await side("Foreign only", ids.userB);
    await side("Private only", ids.userA, true);
    await side("Duplicate name");
    await side("Duplicate name");
    for (const name of ["Foreign only", "Private only", "Missing name", "Duplicate name"]) {
      expect(await owner((db) => resolveReminderDestination(db, ids.userA, name))).toHaveProperty(
        "reply"
      );
    }
  });
  it("the worker policy binds the reserved result to its destination (mutation check)", async () => {
    const target = await side("Policy target");
    const wrong = await side("Policy wrong thread");
    const saved = await save(target.id, "this chat");
    const insert = () =>
      worker.withDataContext({ actorUserId: ids.userA }, (db) =>
        chat.insertReservedAssistantMessage(db, {
          id: saved.reserved_message_id,
          threadId: wrong.id,
          body: "wrong destination",
          origin: {
            version: 1,
            kind: "reminder",
            event: "delivered",
            reminderId: saved.id,
            late: false
          },
          now: new Date()
        })
      );
    await expect(insert()).rejects.toMatchObject({ code: "42501" });
    const policy = await bootstrap.query(
      "SELECT pg_get_expr(polwithcheck, polrelid) AS predicate FROM pg_policy WHERE polrelid = 'app.chat_messages'::regclass AND polname = 'chat_messages_insert_reminder'"
    );
    const predicate = policy.rows[0]!.predicate as string;
    try {
      await bootstrap.query(
        "ALTER POLICY chat_messages_insert_reminder ON app.chat_messages WITH CHECK (true)"
      );
      await expect(insert()).resolves.toBeUndefined();
    } finally {
      await bootstrap.query(
        `ALTER POLICY chat_messages_insert_reminder ON app.chat_messages WITH CHECK (${predicate})`
      );
      await bootstrap.query("DELETE FROM app.chat_messages WHERE id = $1", [
        saved.reserved_message_id
      ]);
    }
    await expect(insert()).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps a missing destination visible as failed instead of silently posting to Main", async () => {
    const target = await side("Gone target");
    const saved = await save(target.id, "this chat");
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [target.id]);
    await due(saved.id);
    expect(await deliver(saved.id, saved.version)).toBe("destination_unavailable");
    const row = await owner((db) => reminders.readState(db, saved.id));
    expect(row?.state).toBe("failed");
    expect(await owner((db) => chat.getMessageById(db, saved.reserved_message_id))).toBeUndefined();
  });
  it("account deletion removes reminders even after their destination was deleted", async () => {
    const actor = randomUUID();
    await bootstrap.query("INSERT INTO app.users (id, email) VALUES ($1, $2)", [
      actor,
      `${actor}@example.test`
    ]);
    const live = await side("Account live", actor);
    const gone = await side("Account gone", actor);
    const first = await save(live.id, "this chat", actor);
    const second = await save(gone.id, "this chat", actor);
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [gone.id]);
    const before = await bootstrap.query(
      "SELECT id FROM app.chat_reminders WHERE owner_user_id = $1",
      [actor]
    );
    expect(before.rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    const fk = await bootstrap.query(
      "SELECT confdeltype FROM pg_constraint WHERE conrelid = 'app.chat_reminders'::regclass AND conname = 'chat_reminders_owner_user_id_fkey'"
    );
    expect(fk.rows[0]?.confdeltype).toBe("c");
    await bootstrap.query("DELETE FROM app.users WHERE id = $1", [actor]);
    const after = await bootstrap.query(
      "SELECT id FROM app.chat_reminders WHERE owner_user_id = $1",
      [actor]
    );
    expect(after.rows).toEqual([]);
  });
});
