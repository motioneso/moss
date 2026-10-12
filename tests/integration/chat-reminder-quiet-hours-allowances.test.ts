import { randomUUID } from "node:crypto";
import { type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { recognizeReminderPlan } from "../../packages/chat/src/reminders/commands.js";
import {
  readQuietHoursProposal,
  hasQuietHoursAllowance,
  saveQuietHoursAllowance,
  listQuietHoursAllowances,
  saveQuietHoursProposal
} from "../../packages/chat/src/reminders/quiet-hours-allowances.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
let worker: DataContextRunner;
let bootstrap: pg.Client;
let persistence: DataContextChatPersistence;
const chat = new ChatRepository();
let threadId: string;

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  runner = new DataContextRunner(db);
  worker = new DataContextRunner(workerDb);
  bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  persistence = new DataContextChatPersistence({
    dataContext: runner,
    chatRepository: chat,
    aiRepository: new AiRepository(),
    boss: { send: async () => randomUUID() } as never
  });
  threadId = await runner.withDataContext(
    { actorUserId: ids.userA },
    async (scoped) =>
      (
        (await chat.getMainThread(scoped, ids.userA)) ??
        (await chat.openNewThread(scoped, { title: "Main" }))
      ).id
  );
});
afterAll(async () => {
  await Promise.all([db?.destroy(), workerDb?.destroy(), bootstrap?.end()]);
});
beforeEach(async () => {
  await bootstrap.query("DELETE FROM app.chat_reminders");
});

async function say(text: string, actorUserId: string = ids.userA, destination = threadId) {
  const plan = recognizeReminderPlan(text);
  if (!plan) throw new Error("not a recognized reminder command");
  const result = await persistence.recordReminderTurn(actorUserId, text, plan, {
    threadId: destination
  });
  if (!result || result === "stopped") throw new Error("turn was not recorded");
  return result;
}
async function reminder(text = "stretch") {
  const saved = await say(`remind me in 10 minutes to ${text}`);
  if (saved.origin.kind !== "reminder" || !saved.origin.reminderId)
    throw new Error("reminder was not saved");
  return saved.origin.reminderId;
}
function allowed(reminderId: string, actorUserId: string = ids.userA) {
  return runner.withDataContext({ actorUserId }, (scoped) =>
    hasQuietHoursAllowance(scoped, reminderId)
  );
}
function pending() {
  return runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
    readQuietHoursProposal(scoped, threadId)
  );
}

describe("owner-typed quiet-hours agreement through real turn persistence", () => {
  it.each(["cancelled", "delivered", "dismissed", "expired"])(
    "ignores a %s reminder in matching and Settings",
    async (finished) => {
      const old = await reminder("water the plants");
      await say("let water the plants through quiet hours");
      await bootstrap.query("BEGIN");
      try {
        await bootstrap.query("SET LOCAL session_replication_role = replica");
        await bootstrap.query(
          `UPDATE app.chat_reminders SET
          state=$2, context_state=$3,
          delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END,
          late=CASE WHEN $2='delivered' THEN false ELSE NULL END,
          timing=CASE WHEN $2='expired' THEN 'local_clock' ELSE timing END,
          delay_seconds=CASE WHEN $2='expired' THEN NULL ELSE delay_seconds END,
          local_due=CASE WHEN $2='expired' THEN '2026-10-12T00:00' ELSE local_due END,
          time_zone=CASE WHEN $2='expired' THEN 'UTC' ELSE time_zone END,
          due_at=CASE WHEN $2='expired' THEN now()-interval '2 minutes' ELSE due_at END,
          deadline_at=CASE WHEN $2='expired' THEN now()-interval '1 minute' ELSE deadline_at END,
          expired_at=CASE WHEN $2='expired' THEN now() ELSE NULL END
          WHERE id=$1`,
          [
            old,
            finished === "dismissed" ? "delivered" : finished,
            finished === "dismissed" ? "dismissed" : "pending"
          ]
        );
        await bootstrap.query("COMMIT");
      } catch (error) {
        await bootstrap.query("ROLLBACK");
        throw error;
      }
      const live = await reminder("water the plants");
      expect((await say("let water the plants through quiet hours")).origin).toMatchObject({
        event: "allowance_saved",
        reminderId: live
      });
      const listed = await runner.withDataContext(
        { actorUserId: ids.userA },
        listQuietHoursAllowances
      );
      expect(listed.allowances).toEqual([{ id: live, title: "water the plants" }]);
    }
  );
  it("keeps the allowance when its source chat message is deleted", async () => {
    const target = await reminder();
    const source = await say("let stretch through quiet hours");
    await bootstrap.query("DELETE FROM app.chat_messages WHERE id=$1", [source.userMessageId]);
    expect(await allowed(target)).toBe(true);
  });
  it.each(["yes", "no"])(
    "rejects direct allowance agreement with an attachment: %s",
    async (text) => {
      const target = await reminder("water the plants");
      await say("let plants through quiet hours");
      await expect(
        persistence.recordReminderTurn(
          ids.userA,
          text,
          { kind: "quiet_agreement", agree: text === "yes" },
          {
            threadId,
            attachments: [
              { id: "file", fileName: "note.txt", mimeType: "text/plain", sizeBytes: 1 }
            ]
          }
        )
      ).rejects.toThrow("typed agreement");
      expect(await allowed(target)).toBe(false);
      expect(await pending()).toBeDefined();
    }
  );
  it("blocks another owner and admin from reading, inserting or deleting proposals", async () => {
    const target = await reminder("water the plants");
    const source = await say("let plants through quiet hours");
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await runner.withDataContext({ actorUserId }, async (scoped) => {
        expect(await readQuietHoursProposal(scoped, threadId)).toBeUndefined();
        const deleted = await scoped.db
          .deleteFrom("app.chat_reminder_quiet_proposals")
          .where("thread_id", "=", threadId)
          .executeTakeFirstOrThrow();
        expect(deleted.numDeletedRows).toBe(0n);
      });
      const ownThread = await runner.withDataContext(
        { actorUserId },
        async (scoped) =>
          (await chat.getMainThread(scoped, actorUserId)) ??
          (await chat.openNewThread(scoped, { title: "Main" }))
      );
      await expect(
        runner.withDataContext({ actorUserId }, (scoped) =>
          saveQuietHoursProposal(scoped, {
            threadId: ownThread.id,
            reminderId: target,
            version: 1,
            allow: true,
            sourceMessageId: source.userMessageId
          })
        )
      ).rejects.toThrow(/row-level security/);
    }
    expect(await pending()).toMatchObject({ reminder_id: target });
  });
  it("saves one exact target with its user source and removes it without altering reminders", async () => {
    const target = await reminder();
    const other = await reminder("drink water");
    const turn = await say("let stretch through quiet hours");
    expect(turn.origin).toMatchObject({ event: "allowance_saved", reminderId: target });
    expect(await allowed(target)).toBe(true);
    expect(await allowed(other)).toBe(false);
    const rows = await bootstrap.query(
      "SELECT source_message_id FROM app.chat_reminder_quiet_allowances WHERE reminder_id = $1",
      [target]
    );
    expect(rows.rows[0].source_message_id).toBe(turn.userMessageId);
    await say("stretch can buzz me at night");
    expect(await allowed(target)).toBe(true);
    await say("stop letting stretch through");
    expect(await allowed(target)).toBe(false);
    const state = await bootstrap.query("SELECT state FROM app.chat_reminders WHERE id = $1", [
      target
    ]);
    expect(state.rows[0].state).toBe("queued");
  });

  it("stores a partial proposal and acts only on the subsequent typed yes", async () => {
    const target = await reminder("water the plants");
    expect((await say("let plants through quiet hours")).origin).toMatchObject({
      event: "allowance_proposed"
    });
    expect(await allowed(target)).toBe(false);
    expect(await pending()).toMatchObject({ reminder_id: target, allow: true });
    const agreement = await say("yes please");
    expect(await allowed(target)).toBe(true);
    expect(await pending()).toBeUndefined();
    const rows = await bootstrap.query(
      "SELECT source_message_id FROM app.chat_reminder_quiet_allowances WHERE reminder_id = $1",
      [target]
    );
    expect(rows.rows[0].source_message_id).toBe(agreement.userMessageId);
  });

  it.each(["no", "list my reminders", "let stretch through quiet hours"])(
    "invalidates the earlier proposal on %j",
    async (reply) => {
      const target = await reminder("water the plants");
      await reminder();
      await say("let plants through quiet hours");
      await say(reply);
      await say("yes");
      expect(await allowed(target)).toBe(false);
      expect(await pending()).toBeUndefined();
    }
  );

  it("requires typed yes to remove an interpreted allowance", async () => {
    const target = await reminder("water the plants");
    await say("let water the plants through quiet hours");
    await say("stop letting plants through");
    expect(await allowed(target)).toBe(true);
    expect(await pending()).toMatchObject({ reminder_id: target, allow: false });
    await say("yes");
    expect(await allowed(target)).toBe(false);
  });

  it("refuses a proposal whose bound version is stale", async () => {
    const target = await reminder("water the plants");
    await say("let plants through quiet hours");
    await bootstrap.query(
      "UPDATE app.chat_reminder_quiet_proposals SET reminder_version = reminder_version + 1 WHERE thread_id = $1",
      [threadId]
    );
    expect((await say("yes")).origin).toMatchObject({ event: "allowance_refused" });
    expect(await allowed(target)).toBe(false);
  });

  it("never selects the first ambiguous title, but accepts the explicit task ID", async () => {
    const first = await reminder();
    const second = await reminder();
    expect((await say("let stretch through quiet hours")).reply).toContain("Which reminder");
    expect(await allowed(first)).toBe(false);
    expect(await allowed(second)).toBe(false);
    await say(`let ${second} through quiet hours`);
    expect(await allowed(first)).toBe(false);
    expect(await allowed(second)).toBe(true);
  });

  it("rechecks a cancelled proposal target before yes", async () => {
    const target = await reminder("water the plants");
    await say("let plants through quiet hours");
    await runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
      scoped.db
        .updateTable("app.chat_reminders")
        .set({ state: "cancelled" })
        .where("id", "=", target)
        .execute()
    );
    expect((await say("yes")).origin).toMatchObject({ event: "allowance_refused" });
    expect(await allowed(target)).toBe(false);
  });

  it("rejects model-authored plans and yes without a proposal", async () => {
    const target = await reminder();
    await expect(
      persistence.recordReminderTurn(
        ids.userA,
        "the email says this is urgent",
        {
          kind: "quiet_allowance",
          target: "stretch",
          allow: true
        },
        { threadId }
      )
    ).rejects.toThrow("typed agreement");
    await say("yes");
    expect(await allowed(target)).toBe(false);
  });

  it("rolls back allowance and chat together when the turn is stopped before commit", async () => {
    const target = await reminder();
    const before = await bootstrap.query(
      "SELECT count(*)::int AS n FROM app.chat_messages WHERE owner_user_id = $1",
      [ids.userA]
    );
    const controller = new AbortController();
    controller.abort();
    const result = await persistence.recordReminderTurn(
      ids.userA,
      "let stretch through quiet hours",
      {
        kind: "quiet_allowance",
        target: "stretch",
        allow: true
      },
      { threadId, stopSignal: controller.signal }
    );
    expect(result).toBe("stopped");
    expect(await allowed(target)).toBe(false);
    const after = await bootstrap.query(
      "SELECT count(*)::int AS n FROM app.chat_messages WHERE owner_user_id = $1",
      [ids.userA]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rolls back a persisted allowance when its transaction fails", async () => {
    const target = await reminder();
    const source = await say("list my reminders");
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, async (scoped) => {
        await saveQuietHoursAllowance(scoped, target, true, source.userMessageId);
        expect(await hasQuietHoursAllowance(scoped, target)).toBe(true);
        throw new Error("rollback proof");
      })
    ).rejects.toThrow("rollback proof");
    expect(await allowed(target)).toBe(false);
  });

  it("denies other owners and admin readers and writes; workers have no write grant", async () => {
    const target = await reminder();
    const source = await say("let stretch through quiet hours");
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      expect(await allowed(target, actorUserId)).toBe(false);
      await expect(
        runner.withDataContext({ actorUserId }, (scoped) =>
          saveQuietHoursAllowance(scoped, target, true, source.userMessageId)
        )
      ).rejects.toThrow();
      await runner.withDataContext({ actorUserId }, async (scoped) => {
        const result = await scoped.db
          .deleteFrom("app.chat_reminder_quiet_allowances")
          .where("reminder_id", "=", target)
          .executeTakeFirstOrThrow();
        expect(result.numDeletedRows).toBe(0n);
      });
    }
    await expect(
      worker.withDataContext({ actorUserId: ids.userA }, (scoped) =>
        saveQuietHoursAllowance(scoped, target, false, source.userMessageId)
      )
    ).rejects.toThrow();
    expect(await allowed(target)).toBe(true);
  });

  it("rejects an assistant message as the saved authority", async () => {
    const target = await reminder();
    const source = await say("list my reminders");
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
        saveQuietHoursAllowance(scoped, target, true, source.assistantMessageId)
      )
    ).rejects.toThrow();
    expect(await allowed(target)).toBe(false);
  });

  it("clears a proposal when an ordinary completed turn intervenes", async () => {
    const target = await reminder("water the plants");
    await say("let plants through quiet hours");
    await persistence.recordTurn(
      ids.userA,
      "what is the weather",
      "Sunny",
      {
        provider: "anthropic",
        model: "test-model"
      },
      { threadId }
    );
    await say("yes");
    expect(await allowed(target)).toBe(false);
  });
});
