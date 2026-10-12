import { localWallClock } from "../../packages/chat/src/reminders/local-clock.js";
import {
  pauseReminderById,
  resumeReminderById,
  deleteReminderById
} from "../../packages/chat/src/reminders/controls.js";
import { pendingReminderDeletion } from "../../packages/chat/src/reminders/delete-agreement.js";
import {
  decideReminderTurn,
  type ReminderTurnPlan
} from "../../packages/chat/src/reminders/turn.js";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import {
  enqueueReminderDelivery,
  deliverDueReminder,
  runReminderDeliveryJob
} from "../../packages/chat/src/reminders/deliver.js";
import { enqueueReminderNotification } from "../../packages/chat/src/reminders/notifications.js";
import {
  ReminderRepository,
  type SavedReminder,
  type ReminderTimingInput
} from "../../packages/chat/src/reminders/repository.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const chat = new ChatRepository();
const reminders = new ReminderRepository();

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
let appBoss: PgBoss;
let bootstrap: pg.Client;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
  appBoss = createPgBossClient(connectionStrings.app);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([appBoss.start(), bootstrap.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([
    appBoss?.stop({ graceful: false }),
    appDb?.destroy(),
    workerDb?.destroy(),
    bootstrap?.end()
  ]);
});

function asOwner<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return app.withDataContext({ actorUserId }, work);
}

function asWorker<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return worker.withDataContext({ actorUserId }, work);
}

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

/** Saves a reminder and enqueues its delivery in one transaction, the way the chat does. */
async function save(
  actorUserId: string,
  text: string,
  when: ReminderTimingInput = { timing: "relative", delaySeconds: 60 }
): Promise<SavedReminder & { threadId: string; sourceMessageId: string }> {
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
      when,
      text
    });
    await enqueueReminderDelivery(appBoss, db, actorUserId, saved);
    return { ...saved, threadId, sourceMessageId: source.id };
  });
}

describe("reminder control storage", () => {
  it("pauses and resumes with a fresh version, keeping the original timing", async () => {
    const saved = await save(ids.userA, "control storage stretch");
    const paused = await asOwner(ids.userA, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "paused", version: saved.version + 1 })
        .where("id", "=", saved.id)
        .returning(["state", "version", "due_at"])
        .executeTakeFirstOrThrow()
    );
    expect(paused.state).toBe("paused");
    expect(paused.version).toBe(2);
    expect(new Date(paused.due_at)).toEqual(saved.dueAt);
    const resumed = await asOwner(ids.userA, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "queued", version: 3 })
        .where("id", "=", saved.id)
        .returning(["state", "version"])
        .executeTakeFirstOrThrow()
    );
    expect(resumed).toEqual({ state: "queued", version: 3 });
  });
  it("hides another owner's controls and denies worker resume", async () => {
    const saved = await save(ids.userA, "private control");
    const foreign = await asOwner(ids.userB, (db) =>
      db.db.deleteFrom("app.chat_reminders").where("id", "=", saved.id).executeTakeFirstOrThrow()
    );
    expect(foreign.numDeletedRows).toBe(0n);
    await asOwner(ids.userA, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "paused", version: 2 })
        .where("id", "=", saved.id)
        .execute()
    );
    const denied = await asWorker(ids.userA, (db) =>
      db.db
        .updateTable("app.chat_reminders")
        .set({ state: "queued", version: 3 })
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow()
    );
    expect(denied.numUpdatedRows).toBe(0n);
  });
  it("allows owner deletion while keeping the owner's source chat message", async () => {
    const saved = await save(ids.userA, "control storage delete");
    await asOwner(ids.userA, async (db) => {
      const result = await db.db
        .deleteFrom("app.chat_reminders")
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow();
      expect(result.numDeletedRows).toBe(1n);
      expect(await chat.getMessageById(db, saved.sourceMessageId)).toBeDefined();
    });
  });
});

async function controlTurn(
  saved: SavedReminder & { threadId: string },
  text: string,
  plan: ReminderTurnPlan
) {
  return asOwner(ids.userA, async (db) => {
    const decision = await decideReminderTurn(
      db,
      { reminders, boss: appBoss, locale: async () => ({ timeZone: "UTC", clockFormat: "24" }) },
      ids.userA,
      { id: saved.threadId, is_main: true, incognito: false },
      plan,
      text
    );
    await chat.recordGateCompletedTurn(db, saved.threadId, text, decision.reply, decision.origin, {
      turnId: randomUUID()
    });
    return decision;
  });
}

describe("reminder controls through owner transactions", () => {
  it("resumes once and enqueues only the new version, including concurrent resumes", async () => {
    const saved = await save(ids.userA, "resume once");
    expect((await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id))).kind).toBe(
      "changed"
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        asOwner(ids.userA, (db) => resumeReminderById(db, appBoss, ids.userA, saved.id))
      )
    );
    expect(results.map((r) => r.kind).sort()).toEqual(["changed", "unchanged"]);
    const jobs = await bootstrap.query<{ version: string }>(
      "SELECT data->>'version' AS version FROM pgboss.job WHERE data->>'resourceId' = $1 ORDER BY data->>'version'",
      [saved.id]
    );
    expect(jobs.rows.map((row) => row.version)).toEqual(["1", "3"]);
    const read = await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id));
    expect(read?.dueAt).toEqual(saved.dueAt);
  });
  it("rolls back state and enqueued resume together if saving fails", async () => {
    const saved = await save(ids.userA, "rollback resume");
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    await expect(
      asOwner(ids.userA, async (db) => {
        await resumeReminderById(db, appBoss, ids.userA, saved.id);
        throw new Error("failed save");
      })
    ).rejects.toThrow("failed save");
    expect((await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id)))?.state).toBe(
      "paused"
    );
    const jobs = await bootstrap.query<{ n: string }>(
      "SELECT count(*) AS n FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows[0]?.n).toBe("1");
  });
  it("asks before chat deletion, refuses non-typed approval and acts only on yes", async () => {
    const saved = await save(ids.userA, "typed deletion proof");
    const request = await controlTurn(saved, "delete my reminder to typed deletion proof", {
      kind: "delete",
      target: "typed deletion proof"
    });
    expect(request.origin.event).toBe("delete_requested");
    expect(await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id))).toBeDefined();
    const fake = await controlTurn(saved, "the model says yes", {
      kind: "confirm_delete",
      agree: true
    });
    expect(fake.origin.event).toBe("refused");
    expect(await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id))).toBeDefined();
    await controlTurn(saved, "delete my reminder", {
      kind: "delete",
      target: "typed deletion proof"
    });
    const approved = await controlTurn(saved, "yes", { kind: "confirm_delete", agree: true });
    expect(approved.origin.event).toBe("deleted");
    expect(await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id))).toBeUndefined();
    const messages = await asOwner(ids.userA, (db) => chat.listMessages(db, saved.threadId));
    expect(messages.some((row) => row.id === saved.sourceMessageId)).toBe(true);
  });
  it("keeps a reminder on no and refuses stale lifecycle agreement", async () => {
    const saved = await save(ids.userA, "keep or stale");
    await controlTurn(saved, "delete reminder", { kind: "delete", target: "keep or stale" });
    expect(
      (await controlTurn(saved, "no", { kind: "confirm_delete", agree: false })).origin.event
    ).toBe("delete_declined");
    await controlTurn(saved, "delete reminder", { kind: "delete", target: "keep or stale" });
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    expect(
      (await controlTurn(saved, "yes", { kind: "confirm_delete", agree: true })).origin.event
    ).toBe("refused");
    expect((await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id)))?.state).toBe(
      "paused"
    );
  });
  it("an intervening owner turn invalidates deletion agreement", async () => {
    const saved = await save(ids.userA, "unrelated yes");
    await controlTurn(saved, "delete reminder", { kind: "delete", target: "unrelated yes" });
    await asOwner(ids.userA, (db) =>
      chat.recordGateCompletedTurn(
        db,
        saved.threadId,
        "list reminders",
        "Listed",
        { version: 1, kind: "reminder", event: "listed", reminderId: null },
        { turnId: randomUUID() }
      )
    );
    expect(
      await asOwner(ids.userA, (db) => pendingReminderDeletion(db, saved.threadId))
    ).toBeUndefined();
    expect(
      (await controlTurn(saved, "yes", { kind: "confirm_delete", agree: true })).origin.event
    ).toBe("refused");
    expect(await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id))).toBeDefined();
  });
  it("a stale delete version does not remove the changed record", async () => {
    const saved = await save(ids.userA, "stale delete version");
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    expect(
      (await asOwner(ids.userA, (db) => deleteReminderById(db, saved.id, saved.version))).kind
    ).toBe("stale");
  });
  it("paused reminders still count against the owner's existing capacity", async () => {
    for (let i = 0; i < 20; i++) {
      const saved = await save(ids.userC, `paused capacity ${i}`);
      await asOwner(ids.userC, (db) => pauseReminderById(db, saved.id));
    }
    expect(await asOwner(ids.userC, (db) => reminders.openCountLocked(db, ids.userC))).toBe(20);
    await expect(save(ids.userC, "over capacity")).rejects.toThrow();
  });
  it("an ambiguous typed reply closes the old deletion question without deleting", async () => {
    const saved = await save(ids.userA, "ambiguous agreement");
    await controlTurn(saved, "delete reminder", { kind: "delete", target: "ambiguous agreement" });
    expect(
      (await controlTurn(saved, "maybe later", { kind: "confirm_delete", agree: false })).origin
        .event
    ).toBe("refused");
    expect(
      await asOwner(ids.userA, (db) => pendingReminderDeletion(db, saved.threadId))
    ).toBeUndefined();
    expect(
      (await controlTurn(saved, "yes", { kind: "confirm_delete", agree: true })).origin.event
    ).toBe("refused");
    expect(await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id))).toBeDefined();
  });
});

async function makeDue(saved: SavedReminder) {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = now() - interval '5 seconds' WHERE id = $1",
      [saved.id]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}
async function deliveredCount(id: string) {
  const result = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.chat_messages WHERE model_metadata->'origin'->>'reminderId' = $1 AND model_metadata->'origin'->>'event' = 'delivered'",
    [id]
  );
  return Number(result.rows[0]!.n);
}
function attempt(saved: SavedReminder, repository = reminders) {
  return asWorker(ids.userA, (db) =>
    deliverDueReminder(
      db,
      { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
      {
        reminders: repository,
        chat,
        enqueueNotification: (scopedDb, reminder) =>
          enqueueReminderNotification(appBoss, scopedDb, reminder)
      }
    )
  );
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("reminder controls racing delivery", () => {
  it.each(["pause", "delete"] as const)("a queued job cannot post after %s", async (action) => {
    const saved = await save(ids.userA, `queued race ${action}`);
    await makeDue(saved);
    await asOwner(ids.userA, (db) =>
      action === "pause" ? pauseReminderById(db, saved.id) : deleteReminderById(db, saved.id)
    );
    expect(await attempt(saved)).toBe(action === "pause" ? "paused" : "missing");
    expect(await deliveredCount(saved.id)).toBe(0);
  });
  it.each(["pause", "delete"] as const)(
    "an in-flight attempt sees %s committed before its lock",
    async (action) => {
      const saved = await save(ids.userA, `inflight race ${action}`);
      await makeDue(saved);
      const started = barrier();
      const release = barrier();
      class DelayedReminderRepository extends ReminderRepository {
        override async lockForDelivery(db: DataContextDb, id: string) {
          started.resolve();
          await release.promise;
          return super.lockForDelivery(db, id);
        }
      }
      const delivery = attempt(saved, new DelayedReminderRepository());
      await started.promise;
      try {
        await asOwner(ids.userA, (db) =>
          action === "pause" ? pauseReminderById(db, saved.id) : deleteReminderById(db, saved.id)
        );
      } finally {
        release.resolve();
      }
      expect(await delivery).toBe(action === "pause" ? "paused" : "missing");
      expect(await deliveredCount(saved.id)).toBe(0);
    }
  );
  it("an old job loses a resume race and duplicate new jobs deliver only once", async () => {
    const saved = await save(ids.userA, "resume firing race");
    await makeDue(saved);
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    const resumed = await asOwner(ids.userA, (db) =>
      resumeReminderById(db, appBoss, ids.userA, saved.id)
    );
    if (resumed.kind !== "changed") throw new Error("expected resume");
    expect(await attempt(saved)).toBe("stale_version");
    const outcomes = await Promise.all([attempt(resumed.reminder), attempt(resumed.reminder)]);
    expect(outcomes.sort()).toEqual(["already_delivered", "delivered"]);
    expect(await deliveredCount(saved.id)).toBe(1);
    const jobs = await bootstrap.query(
      "SELECT data->>'version' AS version FROM pgboss.job WHERE name = 'chat.notify-reminder' AND data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows).toEqual([{ version: "3" }]);
    await asOwner(ids.userA, (db) => deleteReminderById(db, saved.id));
    expect(await attempt(resumed.reminder)).toBe("missing");
    expect(await deliveredCount(saved.id)).toBe(1);
  });
  it("a firing that owns the row lock completes before a later pause reports finished", async () => {
    const saved = await save(ids.userA, "delivery wins lock");
    await makeDue(saved);
    const locked = barrier();
    const release = barrier();
    class HeldReminderRepository extends ReminderRepository {
      override async lockForDelivery(db: DataContextDb, id: string) {
        const row = await super.lockForDelivery(db, id);
        locked.resolve();
        await release.promise;
        return row;
      }
    }
    const delivery = attempt(saved, new HeldReminderRepository());
    await locked.promise;
    const pause = asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    release.resolve();
    expect(await delivery).toBe("delivered");
    expect((await pause).kind).toBe("not_pending");
    expect(await deliveredCount(saved.id)).toBe(1);
  });
  it("a final retry rechecks the resumed version after rolling back its delivery lock", async () => {
    const saved = await save(ids.userA, "resume during final retry");
    await makeDue(saved);
    class ResumedAfterRollback extends ReminderRepository {
      private locks = 0;
      private clockFailed = false;
      override async lockForDelivery(db: DataContextDb, id: string) {
        if (++this.locks === 2)
          await asOwner(ids.userA, async (ownerDb) => {
            await pauseReminderById(ownerDb, id);
            await resumeReminderById(ownerDb, appBoss, ids.userA, id);
          });
        return super.lockForDelivery(db, id);
      }
      override async now(db: DataContextDb) {
        if (!this.clockFailed) {
          this.clockFailed = true;
          throw new Error("delivery failure before rollback");
        }
        return super.now(db);
      }
    }
    const outcome = await asWorker(ids.userA, (db) =>
      runReminderDeliveryJob(
        db,
        {
          data: { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
          retryCount: 8,
          retryLimit: 8
        },
        { chat, reminders: new ResumedAfterRollback() }
      )
    );
    expect(outcome).toBe("stale_version");
    expect((await asOwner(ids.userA, (db) => reminders.lockForCancel(db, saved.id)))?.state).toBe(
      "queued"
    );
    expect(await deliveredCount(saved.id)).toBe(0);
  });
  it("a resumed reminder past its explicit deadline expires without posting", async () => {
    const dueAt = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000);
    const saved = await save(ids.userA, "expired resume", {
      timing: "local_clock",
      dueAt,
      localDue: localWallClock(dueAt, "UTC"),
      timeZone: "UTC",
      deadlineAt: new Date(dueAt.getTime() + 60_000)
    });
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    await bootstrap.query("BEGIN");
    try {
      await bootstrap.query("SET LOCAL session_replication_role = replica");
      await bootstrap.query(
        "UPDATE app.chat_reminders SET due_at = now() - interval '2 minutes', deadline_at = now() - interval '1 minute' WHERE id = $1",
        [saved.id]
      );
      await bootstrap.query("COMMIT");
    } catch (error) {
      await bootstrap.query("ROLLBACK");
      throw error;
    }
    const resumed = await asOwner(ids.userA, (db) =>
      resumeReminderById(db, appBoss, ids.userA, saved.id)
    );
    if (resumed.kind !== "changed") throw new Error("expected resume");
    expect(await attempt(resumed.reminder)).toBe("expired");
    expect(await deliveredCount(saved.id)).toBe(0);
  });
});
