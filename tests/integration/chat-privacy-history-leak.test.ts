/**
 * #1038 — two-user isolation regression for the chat privacy/history HTTP endpoints.
 *
 * `ChatRepository.listThreads` (packages/chat/src/repository.ts) issues no
 * `owner_user_id` filter — isolation on `GET /api/chat/threads` is enforced entirely by
 * RLS on the request-scoped connection. This test proves that guarantee holds across
 * both the list endpoint and the detail (`/messages`) endpoint: actor B's threads and
 * messages must never appear in any response served to actor A, and vice versa.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { ChatRepository } from "@moss/chat";
import type { ChatEngineFactory } from "@moss/module-registry";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/** Never launched by this test (no /api/chat/turn call) — satisfies the type only. */
class UnusedLiveEngine implements CliChatEngine {
  constructor(public readonly provider: CliChatEngine["provider"]) {}
  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(_text: string): Promise<void> {}
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    return { records: [], offset: afterOffset, complete: false };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

const unusedEngineFactory: ChatEngineFactory = (provider) => new UnusedLiveEngine(provider);

describe("Chat privacy/history endpoints — two-user isolation (#1038)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let server: ReturnType<typeof createApiServer>;
  let threadA: { id: string };
  let threadB: { id: string };

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    server = createApiServer({
      appDb,
      logger: false,
      chatEngineFactory: unusedEngineFactory
    });
    await server.ready();

    threadA = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "Actor A's thread" });
      await repository.recordCompletedTurn(
        scopedDb,
        created.id,
        "actor-a-private-question",
        "actor-a-private-answer",
        { provider: "anthropic", model: "claude-live" }
      );
      return created;
    });

    threadB = await dataContext.withDataContext(userBContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "Actor B's thread" });
      await repository.recordCompletedTurn(
        scopedDb,
        created.id,
        "actor-b-private-question",
        "actor-b-private-answer",
        { provider: "anthropic", model: "claude-live" }
      );
      return created;
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
  });

  it("GET /api/chat/threads never lists another actor's threads", async () => {
    const asA = await server.inject({
      method: "GET",
      url: "/api/chat/threads",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const asB = await server.inject({
      method: "GET",
      url: "/api/chat/threads",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });

    expect(asA.statusCode).toBe(200);
    expect(asB.statusCode).toBe(200);

    const threadIdsForA = asA
      .json<{ threads: Array<{ id: string; ownerUserId: string }> }>()
      .threads.map((t) => t.id);
    const threadIdsForB = asB
      .json<{ threads: Array<{ id: string; ownerUserId: string }> }>()
      .threads.map((t) => t.id);

    expect(threadIdsForA).toContain(threadA.id);
    expect(threadIdsForA).not.toContain(threadB.id);

    expect(threadIdsForB).toContain(threadB.id);
    expect(threadIdsForB).not.toContain(threadA.id);
  });

  it("GET /api/chat/threads/:id/messages 404s and leaks nothing across actors", async () => {
    const bReadingA = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${threadA.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    const aReadingB = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${threadB.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(bReadingA.statusCode).toBe(404);
    expect(bReadingA.body).not.toContain("actor-a-private");

    expect(aReadingB.statusCode).toBe(404);
    expect(aReadingB.body).not.toContain("actor-b-private");
  });

  it("GET /api/chat/threads/:id/messages returns exactly the owner's own messages", async () => {
    const owner = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${threadA.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(owner.statusCode).toBe(200);
    expect(owner.json<{ messages: Array<{ body: string; role: string }> }>().messages).toEqual([
      expect.objectContaining({ role: "user", body: "actor-a-private-question" }),
      expect.objectContaining({ role: "assistant", body: "actor-a-private-answer" })
    ]);
  });
});

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:chat-privacy-history-leak-a" };
}

function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:chat-privacy-history-leak-b" };
}
