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
  REMINDER_MANAGE_MAIN_ONLY_REPLY,
  reminderCancelReply
} from "../../packages/chat/src/reminders/wording.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3310: list and cancel run through the chat's own turn writer, in the same transaction as the
// user's message and the code-written reply, so a refused or stopped turn changes no reminder.

const NOT_FOUND_REPLY = reminderCancelReply({ kind: "not_found" });

const { Client } = pg;

const chat = new ChatRepository();
const SAVE: ReminderTurnPlan = { kind: "request", delaySeconds: 600, text: "stretch" };
const CANCEL: ReminderTurnPlan = { kind: "cancel", target: "stretch" };
const SAY = "cancel the reminder to stretch";

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

async function saveStretch(threadId: string): Promise<string> {
  const saved = await persistenceWith(appBoss).recordReminderTurn(
    ids.userA,
    "remind me in 10 minutes to stretch",
    SAVE,
    { threadId }
  );
  assertNotStopped(saved);
  return (saved!.origin as { reminderId: string }).reminderId;
}

async function stateOf(reminderId: string): Promise<string> {
  const row = await bootstrap.query<{ state: string }>(
    "SELECT state FROM app.chat_reminders WHERE id = $1",
    [reminderId]
  );
  return row.rows[0]!.state;
}

describe("listing and cancelling reminders from a chat turn (#3310)", () => {
  it("cancels in Main and stores both messages with a cancelled origin", async () => {
    const threadId = await mainThreadId(ids.userA);
    const reminderId = await saveStretch(threadId);
    const before = await counts(ids.userA);

    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, CANCEL, {
      threadId
    });
    assertNotStopped(stored);

    expect(stored?.reply).toBe("Cancelled. I won't remind you: stretch");
    expect(stored?.origin).toEqual({
      kind: "reminder",
      event: "cancelled",
      reminderId,
      version: 1
    });
    expect(await stateOf(reminderId)).toBe("cancelled");
    expect(await counts(ids.userA)).toEqual({ ...before, messages: before.messages + 2 });

    const assistant = await bootstrap.query(
      "SELECT body, model_metadata FROM app.chat_messages WHERE id = $1",
      [stored!.assistantMessageId]
    );
    expect(assistant.rows[0].body).toBe(stored!.reply);
    expect(assistant.rows[0].model_metadata.origin).toEqual(stored!.origin);
  });

  it("lists in Main with a listed origin", async () => {
    const threadId = await mainThreadId(ids.userA);
    await saveStretch(threadId);
    const stored = await persistenceWith(appBoss).recordReminderTurn(
      ids.userA,
      "list my reminders",
      { kind: "list" },
      { threadId }
    );
    assertNotStopped(stored);
    expect(stored?.reply).toMatch(/^Chat reminders waiting:\n- stretch, in (9|10) minutes/);
    expect(stored?.origin).toEqual({
      kind: "reminder",
      event: "listed",
      reminderId: null,
      version: 1
    });
  });

  it("answers a refused cancel with a cancel_refused origin", async () => {
    const threadId = await mainThreadId(ids.userA);
    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, CANCEL, {
      threadId
    });
    assertNotStopped(stored);
    expect(stored?.reply).toBe(NOT_FOUND_REPLY);
    expect(stored?.origin).toMatchObject({ event: "cancel_refused", reminderId: null });
  });

  it("refuses in a chat that is not Main and leaves the reminder waiting", async () => {
    const reminderId = await saveStretch(await mainThreadId(ids.userA));
    const threadId = await otherThreadId(ids.userA, false);
    const refused = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, CANCEL, {
      threadId
    });
    assertNotStopped(refused);
    expect(refused?.reply).toBe(REMINDER_MANAGE_MAIN_ONLY_REPLY);
    expect(await stateOf(reminderId)).toBe("queued");
  });

  it("refuses a module-controlled cancel even in Main", async () => {
    const threadId = await mainThreadId(ids.userA);
    const reminderId = await saveStretch(threadId);
    const refused = await persistenceWith(appBoss).recordReminderTurn(
      ids.userA,
      SAY,
      { kind: "main_only", manage: true },
      { threadId }
    );
    assertNotStopped(refused);
    expect(refused?.reply).toBe(REMINDER_MANAGE_MAIN_ONLY_REPLY);
    expect(await stateOf(reminderId)).toBe("queued");
  });

  it("never cancels another user's reminder from their own Main", async () => {
    const reminderId = await saveStretch(await mainThreadId(ids.userA));
    const threadId = await mainThreadId(ids.userB);
    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userB, SAY, CANCEL, {
      threadId
    });
    assertNotStopped(stored);
    expect(stored?.reply).toBe(NOT_FOUND_REPLY);
    expect(await stateOf(reminderId)).toBe("queued");
  });

  it("rolls the cancel back when the user stops the turn", async () => {
    const threadId = await mainThreadId(ids.userA);
    const reminderId = await saveStretch(threadId);
    const before = await counts(ids.userA);
    const stop = new AbortController();
    stop.abort();

    const stored = await persistenceWith(appBoss).recordReminderTurn(ids.userA, SAY, CANCEL, {
      threadId,
      stopSignal: stop.signal
    });
    expect(stored).toBe("stopped");
    expect(await stateOf(reminderId)).toBe("queued");
    expect(await counts(ids.userA)).toEqual(before);
  });
});
