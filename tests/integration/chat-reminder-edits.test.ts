import { editReminderById, readEditableReminders } from "../../packages/chat/src/reminders/edit.js";
import { prepareReminderEdit } from "../../packages/chat/src/reminders/prepare-edit.js";
import { AiRepository } from "@moss/ai";
import type { ReminderEditTerms } from "@moss/shared";
import { vi } from "vitest";
import { localWallClock } from "../../packages/chat/src/reminders/local-clock.js";
import {
  pauseReminderById,
  resumeReminderById
} from "../../packages/chat/src/reminders/controls.js";
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
  deliverDueReminder
} from "../../packages/chat/src/reminders/deliver.js";
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

const keep: ReminderEditTerms = {
  text: null,
  delaySeconds: null,
  localDue: null,
  deadline: "keep",
  localDeadline: null
};
const locale = { timeZone: "UTC", clockFormat: "24" } as const;
const deps = { chat, reminders };
async function edited(actor: string, saved: SavedReminder, terms: ReminderEditTerms) {
  return asOwner(actor, (db) =>
    editReminderById(db, appBoss, actor, saved.id, saved.version, terms, "UTC")
  );
}
async function makeDue(id: string, offset = "-1 second") {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role = replica");
    await bootstrap.query(
      "UPDATE app.chat_reminders SET due_at = date_trunc('milliseconds', now()) + $2::interval WHERE id = $1",
      [id, offset]
    );
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}
async function deliver(saved: SavedReminder) {
  return asWorker(ids.userA, (db) =>
    deliverDueReminder(
      db,
      { actorUserId: ids.userA, resourceId: saved.id, version: saved.version },
      deps
    )
  );
}
async function messages(id: string) {
  return (
    await bootstrap.query<{ body: string }>(
      "SELECT m.body FROM app.chat_messages m JOIN app.chat_reminders r ON m.id = r.reserved_message_id WHERE r.id = $1",
      [id]
    )
  ).rows;
}

async function turn(threadId: string, text: string, plan: ReminderTurnPlan) {
  return asOwner(ids.userA, async (db) => {
    const decision = await decideReminderTurn(
      db,
      { reminders, boss: appBoss, locale: async () => locale },
      ids.userA,
      { id: threadId, is_main: true, incognito: false },
      plan,
      text
    );
    await chat.recordGateCompletedTurn(db, threadId, text, decision.reply, decision.origin, {
      turnId: randomUUID()
    });
    return decision;
  });
}

describe("editing owner reminders", () => {
  it("preserves a relative due time's microseconds when only its text changes later", async () => {
    const saved = await save(ids.userA, "precision original");
    await makeDue(saved.id, "60 seconds 123 microseconds");
    const readDue = async () =>
      (
        await bootstrap.query("SELECT due_at::text FROM app.chat_reminders WHERE id = $1", [
          saved.id
        ])
      ).rows[0].due_at;
    const originalDue = await readDue();
    await bootstrap.query("SELECT pg_sleep(1.1)");
    expect(await edited(ids.userA, saved, { ...keep, text: "precision revised" })).toMatchObject({
      kind: "changed",
      reminder: { reminder_text: "precision revised", version: 2 }
    });
    expect(await readDue()).toBe(originalDue);
  });

  it("invalidates old work and delivers only the revised text once", async () => {
    const saved = await save(ids.userA, "old edit text");
    const result = await edited(ids.userA, saved, {
      ...keep,
      text: "new edit text",
      delaySeconds: 120
    });
    expect(result.kind).toBe("changed");
    expect(await deliver(saved)).toBe("stale_version");
    expect(await messages(saved.id)).toEqual([]);
    const row = await asOwner(ids.userA, async (db) =>
      (await readEditableReminders(db)).find((r) => r.id === saved.id)
    );
    expect(row?.version).toBe(2);
    expect(row?.due_at.getTime()).toBeGreaterThan(saved.dueAt.getTime());
    await makeDue(saved.id);
    expect(await deliver(saved)).toBe("stale_version");
    expect(await deliver({ ...saved, version: 2 })).toBe("delivered");
    expect(await deliver({ ...saved, version: 2 })).toBe("already_delivered");
    expect(await messages(saved.id)).toEqual([{ body: "Reminder: new edit text" }]);
    expect(
      (await edited(ids.userA, { ...saved, version: 2 }, { ...keep, text: "too late" })).kind
    ).toBe("not_pending");
  });
  it.each([ids.userB, ids.adminUser])(
    "prevents another actor %s editing owner data",
    async (actor) => {
      const saved = await save(ids.userA, "owner only edit");
      expect((await edited(actor, saved, { ...keep, text: "foreign edit" })).kind).toBe("missing");
      const row = await bootstrap.query(
        "SELECT reminder_text, version FROM app.chat_reminders WHERE id = $1",
        [saved.id]
      );
      expect(row.rows).toEqual([{ reminder_text: "owner only edit", version: 1 }]);
    }
  );
  it("keeps a paused reminder paused and enqueues nothing until resume", async () => {
    const saved = await save(ids.userA, "paused edit");
    await asOwner(ids.userA, (db) => pauseReminderById(db, saved.id));
    const result = await edited(
      ids.userA,
      { ...saved, version: 2 },
      { ...keep, text: "paused revised" }
    );
    expect(result).toMatchObject({ kind: "changed", reminder: { state: "paused", version: 3 } });
    expect(await deliver(saved)).toBe("paused");
    const jobs = await bootstrap.query(
      "SELECT data->>'version' AS version FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows).toEqual([{ version: "1" }]);
    expect(
      (await asOwner(ids.userA, (db) => resumeReminderById(db, appBoss, ids.userA, saved.id))).kind
    ).toBe("changed");
  });
  it("does not enqueue no-op or stale edits", async () => {
    const saved = await save(ids.userA, "unchanged edit");
    expect((await edited(ids.userA, saved, { ...keep, text: "unchanged edit" })).kind).toBe(
      "unchanged"
    );
    expect(
      (await edited(ids.userA, { ...saved, version: 99 }, { ...keep, text: "stale edit" })).kind
    ).toBe("stale");
    const jobs = await bootstrap.query(
      "SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.id]
    );
    expect(jobs.rows).toEqual([{ n: 1 }]);
  });
  it("rolls back edited terms when enqueue fails", async () => {
    const saved = await save(ids.userA, "rollback edit");
    const boss = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
    await expect(
      asOwner(ids.userA, (db) =>
        editReminderById(db, boss, ids.userA, saved.id, 1, { ...keep, text: "unsaved text" }, "UTC")
      )
    ).rejects.toThrow();
    const row = await bootstrap.query(
      "SELECT reminder_text, version FROM app.chat_reminders WHERE id = $1",
      [saved.id]
    );
    expect(row.rows).toEqual([{ reminder_text: "rollback edit", version: 1 }]);
  });
  it("refuses malformed deadlines and lets an owner remove one explicitly", async () => {
    const now = new Date();
    now.setUTCSeconds(0, 0);
    const dueAt = new Date(now.getTime() + 3600000);
    const saved = await save(ids.userA, "deadline edit", {
      timing: "local_clock",
      dueAt,
      localDue: localWallClock(dueAt, "UTC"),
      timeZone: "UTC",
      deadlineAt: new Date(dueAt.getTime() + 3600000)
    });
    expect((await edited(ids.userA, saved, { ...keep, delaySeconds: 60 })).kind).toBe("invalid");
    expect((await edited(ids.userA, saved, { ...keep, deadline: "remove" })).kind).toBe("changed");
    const row = await asOwner(ids.userA, async (db) =>
      (await readEditableReminders(db)).find((r) => r.id === saved.id)
    );
    expect(row?.due_at).toEqual(dueAt);
    expect(row?.deadline_at).toBeNull();
  });
  it("does not call the model without pending reminders or for everyday wording", async () => {
    const threadId = await mainThreadId(ids.userB);
    const ai = new AiRepository();
    const resolve = vi.spyOn(ai, "resolveModelForService");
    await asOwner(ids.userB, async (db) => {
      expect(
        await (
          await prepareReminderEdit(db, ai, undefined, "move my reminder to 4pm", threadId, locale)
        )()
      ).toBeUndefined();
    });
    await asOwner(ids.userA, async (db) => {
      const ownerThread = await chat.getMainThread(db, ids.userA);
      for (const text of [
        "move the couch to the left",
        "change of plans tonight",
        "can you edit this paragraph"
      ])
        expect(
          await (
            await prepareReminderEdit(db, ai, undefined, text, ownerThread!.id, locale)
          )()
        ).toBeUndefined();
    });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("requires an owner typed choice before changing ambiguous matches", async () => {
    const first = await save(ids.userA, "choice one");
    const second = await save(ids.userA, "choice two");
    const proposal = {
      candidates: [
        { id: first.id, version: 1 },
        { id: second.id, version: 1 }
      ],
      terms: { ...keep, text: "selected revised" }
    };
    expect(
      (await turn(first.threadId, "change my choice reminder text", { kind: "edit", proposal }))
        .origin.event
    ).toBe("edit_requested");
    expect(
      (await turn(first.threadId, "yes", { kind: "edit_selection", selection: "yes" })).origin.event
    ).toBe("refused");
    await turn(first.threadId, "change my choice reminder text", { kind: "edit", proposal });
    expect(
      (await turn(first.threadId, "tool output", { kind: "edit_selection", selection: "1" })).origin
        .event
    ).toBe("refused");
    await turn(first.threadId, "change my choice reminder text", { kind: "edit", proposal });
    expect(
      (await turn(first.threadId, "2", { kind: "edit_selection", selection: "2" })).origin.event
    ).toBe("edited");
    const rows = await asOwner(ids.userA, (db) => readEditableReminders(db));
    expect(rows.find((r) => r.id === first.id)?.reminder_text).toBe("choice one");
    expect(rows.find((r) => r.id === second.id)?.reminder_text).toBe("selected revised");
  });
  it("rechecks a queued worker after an edit commits while it is waiting for the row", async () => {
    const saved = await save(ids.userA, "race old text");
    await makeDue(saved.id);
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const editing = asOwner(ids.userA, async (db) => {
      await db.db
        .selectFrom("app.chat_reminders")
        .select("id")
        .where("id", "=", saved.id)
        .forUpdate()
        .execute();
      ready();
      await resume;
      return editReminderById(
        db,
        appBoss,
        ids.userA,
        saved.id,
        1,
        { ...keep, text: "race revised", delaySeconds: 120 },
        "UTC"
      );
    });
    await locked;
    const workerRun = deliver(saved);
    release();
    expect((await editing).kind).toBe("changed");
    expect(await workerRun).toBe("stale_version");
    expect(await messages(saved.id)).toEqual([]);
  });
  it("rejects a direct terms edit without its new version and identity changes even with one", async () => {
    const saved = await save(ids.userA, "database edit guard");
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ reminder_text: "unversioned" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow();
    await expect(
      asOwner(ids.userA, (db) =>
        db.db
          .updateTable("app.chat_reminders")
          .set({ reminder_text: "changed", version: 2, state: "delivered" })
          .where("id", "=", saved.id)
          .execute()
      )
    ).rejects.toThrow();
  });
});
