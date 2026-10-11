import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import type { ChatEngineFactory } from "@moss/module-registry";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";

import { createApiServer } from "../../apps/api/src/server.js";
import { INTERRUPTED_REPLY_TEXT } from "../../packages/chat/src/live-turns.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3128: a live reply records its question before the model sees it. A record left by an earlier
// API boot becomes the stored question plus an interrupted note, once, and is never resubmitted.

const { Client } = pg;

const chat = new ChatRepository();
const BOOT_A = randomUUID();
const BOOT_B = randomUUID();
const EXECUTED = { provider: "anthropic" as const, model: "claude-live" };
const ATTACHMENT = {
  id: randomUUID(),
  fileName: "plan.txt",
  mimeType: "text/plain",
  sizeBytes: 12
};

let appDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let bootstrap: pg.Client;

function boot(bootId: string): DataContextChatPersistence {
  return new DataContextChatPersistence({
    dataContext: app,
    chatRepository: chat,
    aiRepository: new AiRepository(),
    bootId
  });
}

async function newThread(actorUserId: string, incognito = false): Promise<string> {
  return app.withDataContext({ actorUserId }, async (db) => {
    const thread = await chat.openNewThread(db, { title: "Chat", incognito });
    return thread.id;
  });
}

async function history(threadId: string) {
  const rows = await bootstrap.query<{
    role: string;
    status: string;
    body: string;
    tool_metadata: Record<string, unknown>;
  }>(
    `SELECT role, status, body, tool_metadata FROM app.chat_messages WHERE thread_id = $1
     ORDER BY created_at, CASE WHEN role = 'user' THEN 0 ELSE 1 END, id`,
    [threadId]
  );
  return rows.rows;
}

async function liveTurnCount(): Promise<number> {
  const rows = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.chat_live_turns"
  );
  return Number(rows.rows[0]!.n);
}

async function begin(bootId: string, threadId: string, userText: string, turnId = randomUUID()) {
  await boot(bootId).beginLiveTurn(ids.userA, {
    turnId,
    threadId,
    userText,
    attachments: [ATTACHMENT]
  });
  return turnId;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  app = new DataContextRunner(appDb);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
});

afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), bootstrap?.end()]);
});

beforeEach(async () => {
  await bootstrap.query("DELETE FROM app.chat_live_turns");
});

describe("interrupted live replies (#3128)", () => {
  it("stores a reply a restart cut off as its question and one interrupted note", async () => {
    const threadId = await newThread(ids.userA);
    const turnId = await begin(BOOT_A, threadId, "book the dentist");

    const first = await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });
    const second = await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    expect(first.recent).toEqual([
      { role: "user", content: "book the dentist" },
      { role: "assistant", content: INTERRUPTED_REPLY_TEXT }
    ]);
    expect(second.recent).toEqual(first.recent);
    const rows = await history(threadId);
    expect(rows.map((row) => [row.role, row.status])).toEqual([
      ["user", "stored"],
      ["assistant", "error"]
    ]);
    expect(rows[0]!.tool_metadata).toMatchObject({ turnId, attachments: [ATTACHMENT] });
    expect(rows[1]!.tool_metadata).toMatchObject({ turnId, interruptedTurn: true });
    expect(await liveTurnCount()).toBe(0);
  });

  it("leaves a reply still running in this boot alone", async () => {
    const threadId = await newThread(ids.userA);
    await begin(BOOT_A, threadId, "still thinking");

    const replay = await boot(BOOT_A).listPriorTurns(ids.userA, { threadId });

    expect(replay.recent).toEqual([]);
    expect(await history(threadId)).toEqual([]);
    expect(await liveTurnCount()).toBe(1);
  });

  it("keeps a completed turn exactly once across a restart", async () => {
    const threadId = await newThread(ids.userA);
    const turnId = await begin(BOOT_A, threadId, "what is on today?");
    await boot(BOOT_A).recordTurn(ids.userA, "what is on today?", "Two meetings.", EXECUTED, {
      threadId,
      turnId
    });

    const replay = await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    expect(replay.recent).toEqual([
      { role: "user", content: "what is on today?" },
      { role: "assistant", content: "Two meetings." }
    ]);
    expect((await history(threadId)).map((row) => row.tool_metadata.turnId)).toEqual([
      turnId,
      turnId
    ]);
    expect(await liveTurnCount()).toBe(0);
  });

  it("saves one turn id once even when the save runs twice", async () => {
    const threadId = await newThread(ids.userA);
    const turnId = await begin(BOOT_A, threadId, "add milk");
    const save = () =>
      boot(BOOT_A).recordTurn(ids.userA, "add milk", "Added.", EXECUTED, { threadId, turnId });

    const first = await save();
    const second = await save();

    expect(second).toEqual(first);
    expect(await history(threadId)).toHaveLength(2);
  });

  it("keeps a reply that finishes after another server process marked it interrupted", async () => {
    const threadId = await newThread(ids.userA);
    const turnId = await begin(BOOT_A, threadId, "water the plants");
    await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    const save = () =>
      boot(BOOT_A).recordTurn(ids.userA, "water the plants", "Done.", EXECUTED, {
        threadId,
        turnId
      });
    const first = await save();
    const second = await save();

    expect(second).toEqual(first);
    expect((await history(threadId)).map((row) => [row.role, row.status, row.body])).toEqual([
      ["user", "stored", "water the plants"],
      ["assistant", "error", INTERRUPTED_REPLY_TEXT],
      ["assistant", "stored", "Done."]
    ]);
  });

  it("keeps an interrupted question in the place it was asked", async () => {
    const threadId = await newThread(ids.userA);
    await begin(BOOT_A, threadId, "earlier question");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await boot(BOOT_A).recordTurn(ids.userA, "later question", "Later answer.", EXECUTED, {
      threadId
    });

    await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    expect((await history(threadId)).map((row) => row.body)).toEqual([
      "earlier question",
      INTERRUPTED_REPLY_TEXT,
      "later question",
      "Later answer."
    ]);
  });

  it("places an interrupted question after the summary's cutoff when the summary already passed it", async () => {
    const threadId = await newThread(ids.userA);
    await begin(BOOT_A, threadId, "earlier question");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = await boot(BOOT_A).recordTurn(
      ids.userA,
      "later question",
      "Later answer.",
      EXECUTED,
      { threadId }
    );
    await bootstrap.query(
      "UPDATE app.chat_threads SET summary_covered_through_message_id = $1 WHERE id = $2",
      [later!.assistantMessageId, threadId]
    );

    await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    expect((await history(threadId)).map((row) => row.body)).toEqual([
      "later question",
      "Later answer.",
      "earlier question",
      INTERRUPTED_REPLY_TEXT
    ]);
  });

  it("titles a chat from its first answered question when the first reply was interrupted", async () => {
    const threadId = await app.withDataContext({ actorUserId: ids.userA }, async (db) => {
      const thread = await chat.openNewThread(db, { title: "Conversation" });
      return thread.id;
    });
    await begin(BOOT_A, threadId, "first question");
    await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    const turnId = await begin(BOOT_B, threadId, "plan the garden");
    await boot(BOOT_B).recordTurn(ids.userA, "plan the garden", "Here is a plan.", EXECUTED, {
      threadId,
      turnId
    });

    const title = await bootstrap.query<{ title: string }>(
      "SELECT title FROM app.chat_threads WHERE id = $1",
      [threadId]
    );
    expect(title.rows[0]!.title).toMatch(/garden/i);
  });

  it("lets the next real turn save and replay after the interrupted one", async () => {
    const threadId = await newThread(ids.userA);
    await begin(BOOT_A, threadId, "first question");
    await boot(BOOT_B).listPriorTurns(ids.userA, { threadId });

    const turnId = await begin(BOOT_B, threadId, "second question");
    await boot(BOOT_B).recordTurn(ids.userA, "second question", "Second answer.", EXECUTED, {
      threadId,
      turnId
    });
    const replay = await boot(randomUUID()).listPriorTurns(ids.userA, { threadId });

    expect(replay.recent).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: INTERRUPTED_REPLY_TEXT },
      { role: "user", content: "second question" },
      { role: "assistant", content: "Second answer." }
    ]);
  });

  it("stores an in-process failure as interrupted and drops a stopped reply", async () => {
    const threadId = await newThread(ids.userA);
    const failed = await begin(BOOT_A, threadId, "the engine died");
    const stopped = await begin(BOOT_A, threadId, "the user stopped");

    await boot(BOOT_A).storeInterruptedLiveTurn(ids.userA, threadId, failed);
    await boot(BOOT_A).discardLiveTurn(ids.userA, stopped);

    expect((await history(threadId)).map((row) => row.body)).toEqual([
      "the engine died",
      INTERRUPTED_REPLY_TEXT
    ]);
    expect(await liveTurnCount()).toBe(0);
  });

  it("never records a private chat's question", async () => {
    const threadId = await newThread(ids.userA, true);

    await expect(begin(BOOT_A, threadId, "private question")).rejects.toThrow(/row-level security/);
    expect(await liveTurnCount()).toBe(0);
  });

  it("keeps one owner's in-flight question away from another user, even on a shared chat", async () => {
    const threadId = await newThread(ids.userA);
    const turnId = await begin(BOOT_A, threadId, "my private question");
    await app.withDataContext({ actorUserId: ids.userA }, (db) =>
      sql`INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
          VALUES ('chat_thread', ${threadId}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, 'manage')`.execute(
        db.db
      )
    );
    const intruder = boot(BOOT_B);

    await intruder.storeInterruptedLiveTurn(ids.userB, threadId, turnId);
    await intruder.discardLiveTurn(ids.userB, turnId);
    await intruder.listPriorTurns(ids.userB, { threadId });
    const seen = await app.withDataContext({ actorUserId: ids.userB }, (db) =>
      db.db.selectFrom("app.chat_live_turns").selectAll().execute()
    );
    await expect(
      boot(BOOT_A).beginLiveTurn(ids.userB, {
        turnId: randomUUID(),
        threadId,
        userText: "planted question"
      })
    ).rejects.toThrow(/row-level security/);

    expect(seen).toEqual([]);
    expect(await liveTurnCount()).toBe(1);
    expect(await history(threadId)).toEqual([]);
  });

  it("grants the app role no update and the worker role nothing", async () => {
    const grants = await bootstrap.query<Record<string, boolean>>(`SELECT
      has_table_privilege('jarvis_app_runtime', 'app.chat_live_turns', 'UPDATE') AS app_update,
      has_table_privilege('jarvis_worker_runtime', 'app.chat_live_turns', 'SELECT') AS worker_select,
      has_table_privilege('jarvis_worker_runtime', 'app.chat_live_turns', 'INSERT') AS worker_insert,
      has_table_privilege('jarvis_worker_runtime', 'app.chat_live_turns', 'DELETE') AS worker_delete`);

    expect(grants.rows[0]).toEqual({
      app_update: false,
      worker_select: false,
      worker_insert: false,
      worker_delete: false
    });
  });
});

describe("reopening an interrupted chat (#3128)", () => {
  class UnusedLiveEngine {
    constructor(readonly provider: string) {}
    async launch(): Promise<{ offset: number }> {
      throw new Error("not used");
    }
    async submit(): Promise<void> {}
    async readNew() {
      return { records: [], offset: 0, complete: true };
    }
    async isAlive(): Promise<boolean> {
      return false;
    }
    async kill(): Promise<void> {}
    async interrupt(): Promise<void> {}
  }
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    server = createApiServer({
      appDb,
      logger: false,
      chatEngineFactory: ((provider: string) =>
        new UnusedLiveEngine(provider)) as unknown as ChatEngineFactory
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("shows the question and the interrupted note in history", async () => {
    const threadId = await newThread(ids.userA);
    await begin(BOOT_A, threadId, "cancel my 3pm");

    const response = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${threadId}/messages`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(response.statusCode).toBe(200);
    const messages = (
      response.json() as { messages: { role: string; status: string; body: string }[] }
    ).messages;
    expect(messages.map((message) => [message.role, message.status, message.body])).toEqual([
      ["user", "stored", "cancel my 3pm"],
      ["assistant", "error", INTERRUPTED_REPLY_TEXT]
    ]);
  });
});
