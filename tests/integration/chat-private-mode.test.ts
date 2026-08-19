import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  ChatRepository,
  DataContextChatPersistence,
  type DataContextChatPersistenceDeps
} from "@moss/chat";
import { createDatabase, DataContextRunner, type AccessContext, type MossDatabase } from "@moss/db";
import { AiRepository } from "@moss/ai";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("private chat persistence", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let aiRepository: AiRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    aiRepository = new AiRepository();
  });

  it("listThreads excludes incognito bookkeeping threads", async () => {
    const normal = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Visible thread" })
    );
    const incognito = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Private bookkeeping", incognito: true })
    );

    const threads = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listThreads(scopedDb)
    );

    expect(threads.some((thread) => thread.id === normal.id)).toBe(true);
    expect(threads.some((thread) => thread.id === incognito.id)).toBe(false);
  });

  it("recordCompletedTurn is a no-op for incognito threads", async () => {
    const result = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.openNewThread(scopedDb, {
        title: "Private bookkeeping",
        incognito: true
      });
      const recorded = await repository.recordCompletedTurn(
        scopedDb,
        thread.id,
        "private user text",
        "private assistant text",
        { provider: "anthropic", model: "claude-economy" }
      );
      const messages = await repository.listMessages(scopedDb, thread.id);
      return { recorded, messages };
    });

    expect(result.recorded).toBeUndefined();
    expect(result.messages).toHaveLength(0);
  });

  it("recordTurn writes zero private rows, no title/summary, and no jobs", async () => {
    const sent: Array<{ readonly queue: string; readonly payload: Record<string, unknown> }> = [];
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      boss: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          sent.push({ queue, payload });
          return "job-id";
        }
      } as DataContextChatPersistenceDeps["boss"]
    });

    await persistence.openNewConversation(ids.userA, { incognito: true });
    await persistence.recordTurn(ids.userA, "Remember nothing from incognito.", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });

    expect(sent).toEqual([]);
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.getCurrentThread(scopedDb, ids.userA);
      expect(thread?.incognito).toBe(true);
      expect(thread?.title).toBe("Conversation");
      expect(thread?.conversation_summary).toBeNull();
      expect(thread).toBeDefined();
      const messages = await repository.listMessages(scopedDb, thread!.id);
      expect(messages).toHaveLength(0);
    });
  });

  it("T2-c: listPriorTurns returns nothing for an incognito thread, even with stored history", async () => {
    // `incognito` is immutable after creation (DB trigger), and
    // recordCompletedTurn no-ops for incognito threads at the repository
    // level, so there is no public-API path to an incognito thread with
    // stored rows. To prove the persistence-level guard (D4) holds
    // independently of that write-time no-op, insert message rows directly
    // (bypassing the repository) into a thread created incognito from the
    // start, then confirm listPriorTurns still returns nothing.
    const thread = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, {
        title: "private bookkeeping with rows",
        incognito: true
      })
    );
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const now = new Date();
      for (let i = 1; i <= 25; i++) {
        await scopedDb.db
          .insertInto("app.chat_messages")
          .values([
            {
              id: randomUUID(),
              thread_id: thread.id,
              owner_user_id: ids.userA,
              role: "user",
              status: "stored",
              body: `q${i}`,
              model_metadata: {},
              tool_metadata: {},
              created_at: now,
              updated_at: now
            },
            {
              id: randomUUID(),
              thread_id: thread.id,
              owner_user_id: ids.userA,
              role: "assistant",
              status: "stored",
              body: `a${i}`,
              model_metadata: {},
              tool_metadata: {},
              created_at: now,
              updated_at: now
            }
          ])
          .execute();
      }
    });

    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      boss: {
        send: async () => "job-id"
      } as unknown as DataContextChatPersistenceDeps["boss"]
    });

    const result = await persistence.listPriorTurns(ids.userA);
    expect(result.recent).toEqual([]);
    expect(result.oldSummary).toBeNull();
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-chat-private"
  };
}
