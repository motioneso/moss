import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { CHAT_DELIVER_REMINDER_QUEUE } from "../../packages/chat/src/reminders/deliver.js";
import type { ReminderTurnPlan } from "../../packages/chat/src/reminders/turn.js";
import {
  REMINDER_CAPACITY_REPLY,
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_OPEN_LIMIT,
  reminderRefusedReply,
  reminderSavedReply
} from "../../packages/chat/src/reminders/wording.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3309: a recognised reminder request is saved through the chat's own turn writer, in the same
// transaction as the user's message, the code-written reply and the delivery job.

const { Client } = pg;

const chat = new ChatRepository();
const REQUEST: ReminderTurnPlan = { kind: "request", delaySeconds: 600, text: "stretch" };
const SAY = "remind me in 10 minutes to stretch";

let appDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let appBoss: PgBoss;
let bootstrap: pg.Client;

function persistenceWith(boss: Pick<PgBoss, "send"> | undefined): DataContextChatPersistence {
  return new DataContextChatPersistence({
    dataContext: app,
    chatRepository: chat,
    aiRepository: new AiRepository(),
    boss: boss as never
  });
}

function asOwner<T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return app.withDataContext({ actorUserId }, work);
}

function assertNotStopped<T>(result: T): asserts result is Exclude<T, "stopped"> {
  if (result === "stopped") throw new Error("the turn reported a stop it never had");
}

async function mainThreadId(actorUserId: string): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const existing = await chat.getMainThread(db, actorUserId);
    return (existing ?? (await chat.openNewThread(db, { title: "Main" }))).id;
  });
}

async function otherThreadId(actorUserId: string, incognito: boolean): Promise<string> {
  return asOwner(actorUserId, async (db) => {
    const thread = await chat.openNewThread(db, { title: "Other", incognito });
    return thread.id;
  });
}

async function counts(actorUserId: string) {
  const reminders = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.chat_reminders WHERE owner_user_id = $1",
    [actorUserId]
  );
  const jobs = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND data->>'actorUserId' = $2",
    [CHAT_DELIVER_REMINDER_QUEUE, actorUserId]
  );
  const messages = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.chat_messages WHERE owner_user_id = $1",
    [actorUserId]
  );
  return {
    reminders: Number(reminders.rows[0]!.n),
    jobs: Number(jobs.rows[0]!.n),
    messages: Number(messages.rows[0]!.n)
  };
}

async function clearReminders(): Promise<void> {
  await bootstrap.query("DELETE FROM pgboss.job WHERE name = $1", [CHAT_DELIVER_REMINDER_QUEUE]);
  await bootstrap.query("DELETE FROM app.chat_reminders");
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  app = new DataContextRunner(appDb);
  appBoss = createPgBossClient(connectionStrings.app);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([appBoss.start(), bootstrap.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([
    appBoss?.stop({ graceful: false }),
    appDb?.destroy(),
    bootstrap?.end()
  ]);
});

beforeEach(clearReminders);

describe("saving a reminder from a chat turn (#3309)", () => {
  it("saves the reminder, its job and both messages in Main", async () => {
    const threadId = await mainThreadId(ids.userA);
    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, REQUEST, {
      threadId
    });
    assertNotStopped(stored);

    expect(stored?.reply).toBe(reminderSavedReply(600, "stretch"));
    expect(stored?.origin).toMatchObject({ kind: "reminder", event: "saved" });
    const reminderId = (stored!.origin as { reminderId: string }).reminderId;

    const row = await bootstrap.query(
      `SELECT owner_user_id, thread_id, source_message_id, reserved_message_id, reminder_text,
              delay_seconds, state
         FROM app.chat_reminders WHERE id = $1`,
      [reminderId]
    );
    expect(row.rows[0]).toMatchObject({
      owner_user_id: ids.userA,
      thread_id: threadId,
      source_message_id: stored!.userMessageId,
      reminder_text: "stretch",
      delay_seconds: 600,
      state: "queued"
    });
    expect(row.rows[0].reserved_message_id).not.toBe(stored!.assistantMessageId);

    const job = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
      [CHAT_DELIVER_REMINDER_QUEUE, reminderId]
    );
    expect(job.rows).toHaveLength(1);
    expect(Object.keys(job.rows[0].data).sort()).toEqual(["actorUserId", "resourceId", "version"]);

    const messages = await bootstrap.query(
      `SELECT id, role, body, model_metadata FROM app.chat_messages
        WHERE id = ANY($1::uuid[]) ORDER BY created_at, role DESC`,
      [[stored!.userMessageId, stored!.assistantMessageId]]
    );
    expect(messages.rows.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    const assistant = messages.rows.find((m) => m.role === "assistant");
    expect(assistant.body).toBe(stored!.reply);
    expect(assistant.model_metadata.origin).toEqual(stored!.origin);
  });

  it("saves a repeated request as its own reminder, each with one job", async () => {
    const threadId = await mainThreadId(ids.userA);
    const persistence = persistenceWith(appBoss);
    const first = await persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId });
    assertNotStopped(first);
    const second = await persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId });
    assertNotStopped(second);
    const firstId = (first!.origin as { reminderId: string }).reminderId;
    const secondId = (second!.origin as { reminderId: string }).reminderId;
    expect(firstId).not.toBe(secondId);
    expect(await counts(ids.userA)).toMatchObject({ reminders: 2, jobs: 2 });
  });

  it("refuses past the open limit without saving a reminder or a job", async () => {
    const threadId = await mainThreadId(ids.userA);
    const persistence = persistenceWith(appBoss);
    for (let i = 0; i < REMINDER_OPEN_LIMIT; i += 1) {
      await persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId });
    }
    expect(await counts(ids.userA)).toMatchObject({ reminders: 20, jobs: 20 });

    const refused = await persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId });
    assertNotStopped(refused);
    expect(refused?.reply).toBe(REMINDER_CAPACITY_REPLY);
    expect(refused?.origin).toMatchObject({ event: "refused", reminderId: null });
    expect(await counts(ids.userA)).toMatchObject({ reminders: 20, jobs: 20 });
  });

  it("lets two concurrent requests at the edge of the limit save only one", async () => {
    const threadId = await mainThreadId(ids.userA);
    const persistence = persistenceWith(appBoss);
    for (let i = 0; i < REMINDER_OPEN_LIMIT - 1; i += 1) {
      await persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId });
    }
    const replies = await Promise.all([
      persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId }),
      persistence.recordReminderTurn(ids.userA, SAY, REQUEST, { threadId })
    ]);
    expect(replies.map((r) => (r === "stopped" ? r : r?.origin))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "saved" }),
        expect.objectContaining({ event: "refused" })
      ])
    );
    expect(await counts(ids.userA)).toMatchObject({ reminders: 20, jobs: 20 });
  });

  it("refuses in a chat that is not Main", async () => {
    const threadId = await otherThreadId(ids.userA, false);
    const before = await counts(ids.userA);
    const refused = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, REQUEST, {
      threadId
    });
    assertNotStopped(refused);
    expect(refused?.reply).toBe(REMINDER_MAIN_ONLY_REPLY);
    expect(await counts(ids.userA)).toEqual({ ...before, messages: before.messages + 2 });
  });

  it("refuses a module-controlled request even in Main", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    const refused = await persistenceWith(appBoss).recordReminderTurn(
      ids.userA,
      SAY,
      { kind: "main_only" },
      { threadId }
    );
    assertNotStopped(refused);
    expect(refused?.reply).toBe(REMINDER_MAIN_ONLY_REPLY);
    expect(await counts(ids.userA)).toEqual({ ...before, messages: before.messages + 2 });
  });

  it("refuses an unsupported request with a reply and saves no reminder", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    const refused = await persistenceWith(appBoss).recordReminderTurn(
      ids.userA,
      "remind me tomorrow at 9am to stretch",
      { kind: "unsupported", reason: "needs_relative_duration" },
      { threadId }
    );
    assertNotStopped(refused);
    expect(refused?.reply).toBe(reminderRefusedReply("needs_relative_duration"));
    expect(refused?.origin).toMatchObject({ event: "refused", reminderId: null });
    expect(await counts(ids.userA)).toEqual({ ...before, messages: before.messages + 2 });
  });

  it("stores nothing at all in a private chat", async () => {
    const threadId = await otherThreadId(ids.userA, true);
    const before = await counts(ids.userA);
    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, REQUEST, {
      threadId
    });
    assertNotStopped(stored);
    expect(stored).toBeUndefined();
    expect(await counts(ids.userA)).toEqual(before);
  });

  it("never saves into another user's chat", async () => {
    const foreignThreadId = await mainThreadId(ids.userB);
    const beforeA = await counts(ids.userA);
    const beforeB = await counts(ids.userB);
    await persistenceWith(appBoss)
      .recordReminderTurn(ids.userA, SAY, REQUEST, { threadId: foreignThreadId })
      .catch(() => undefined);
    expect((await counts(ids.userA)).reminders).toBe(beforeA.reminders);
    expect(await counts(ids.userB)).toEqual(beforeB);
  });

  it("rolls back the messages when the delivery queue is missing", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    await expect(
      persistenceWith(undefined).recordReminderTurn(ids.userA, SAY, REQUEST, { threadId })
    ).rejects.toThrow(/queue is unavailable/);
    expect(await counts(ids.userA)).toEqual(before);
  });

  it("rolls back the reminder and messages when queueing the job fails", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    const failing = {
      send: async () => {
        throw new Error("queue down");
      }
    };
    await expect(
      persistenceWith(failing as never).recordReminderTurn(ids.userA, SAY, REQUEST, { threadId })
    ).rejects.toThrow(/queue down/);
    expect(await counts(ids.userA)).toEqual(before);
  });

  it("rolls back the job when the turn fails after queueing it", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    const queuedThenFails = {
      send: async (...args: Parameters<PgBoss["send"]>) => {
        await (appBoss.send as (...a: unknown[]) => Promise<unknown>)(...args);
        throw new Error("failed after queueing");
      }
    };
    await expect(
      persistenceWith(queuedThenFails as never).recordReminderTurn(ids.userA, SAY, REQUEST, {
        threadId
      })
    ).rejects.toThrow(/failed after queueing/);
    expect(await counts(ids.userA)).toEqual(before);
  });

  it("rolls back the whole turn when the user stops it during the save", async () => {
    const threadId = await mainThreadId(ids.userA);
    const before = await counts(ids.userA);
    const stop = new AbortController();
    const stopsWhileQueueing = {
      send: async (...args: Parameters<PgBoss["send"]>) => {
        const job = await (appBoss.send as (...a: unknown[]) => Promise<unknown>)(...args);
        stop.abort();
        return job;
      }
    };
    const stored = await persistenceWith(stopsWhileQueueing as never).recordReminderTurn(
      ids.userA,
      SAY,
      REQUEST,
      { threadId, stopSignal: stop.signal }
    );
    expect(stored).toBe("stopped");
    expect(await counts(ids.userA)).toEqual(before);
  });
});
