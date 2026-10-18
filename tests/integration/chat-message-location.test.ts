/**
 * #3481: a reminder alert links to its exact chat message. The location route answers only the
 * message's owner; any other actor, a deleted message or a deleted chat gets the same 404.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { ChatRepository } from "@moss/chat";
import type { ChatSurface } from "@moss/shared";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("chat message location (#3481)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let bootstrap: pg.Client;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;
  const repository = new ChatRepository();

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-chat-message-location-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    server = createApiServer({ appDb, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), bootstrap?.end()]);
    if (originalSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
    else process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
  });

  async function turn(title: string) {
    return dataContext.withDataContext(userA(), async (scopedDb) => {
      const thread = await repository.openNewThread(scopedDb, { title });
      const written = await repository.recordCompletedTurn(scopedDb, thread.id, "q", "a", {
        provider: "anthropic",
        model: "claude-live"
      });
      return { thread, message: written!.assistantMessage };
    });
  }

  async function storedMessageIn(opts: { incognito?: boolean; surface?: ChatSurface }) {
    const target = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Target chat", ...opts })
    );
    const messageId = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.chat_messages (id, thread_id, owner_user_id, role, status, body)
       VALUES ($1, $2, $3, 'assistant', 'stored', 'a')`,
      [messageId, target.id, ids.userA]
    );
    return messageId;
  }

  function locate(messageId: string, session: string) {
    return server.inject({
      method: "GET",
      url: `/api/chat/messages/${messageId}/location`,
      headers: { authorization: `Bearer ${session}` }
    });
  }

  it("returns the owner's chat and message", async () => {
    const { thread, message } = await turn("Side chat");
    const response = await locate(message.id, ids.sessionA);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ threadId: thread.id, messageId: message.id });
  });

  it("refuses another account with the same answer as a missing message", async () => {
    const { message } = await turn("A's chat");
    const foreign = await locate(message.id, ids.sessionB);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain(message.id);
    expect(foreign.body).not.toContain("A's chat");
    const missing = await locate("00000000-0000-4000-8000-000000000000", ids.sessionB);
    expect(foreign.json()).toEqual(missing.json());
  });

  it("answers 404 once the message or its chat is gone", async () => {
    const deletedMessage = await turn("Message deleted");
    await bootstrap.query("DELETE FROM app.chat_messages WHERE id = $1", [
      deletedMessage.message.id
    ]);
    expect((await locate(deletedMessage.message.id, ids.sessionA)).statusCode).toBe(404);

    const deletedChat = await turn("Chat deleted");
    await bootstrap.query("DELETE FROM app.chat_threads WHERE id = $1", [deletedChat.thread.id]);
    expect((await locate(deletedChat.message.id, ids.sessionA)).statusCode).toBe(404);
  });

  it("answers 404 for the owner's private chat and a non-drawer chat", async () => {
    // Normal turns never store into these chats, so place a stored message there directly.
    const privateMessage = await storedMessageIn({ incognito: true });
    expect((await locate(privateMessage, ids.sessionA)).statusCode).toBe(404);

    const moduleMessage = await storedMessageIn({ surface: "module-test" as ChatSurface });
    expect((await locate(moduleMessage, ids.sessionA)).statusCode).toBe(404);
  });

  it("answers 404 for a malformed id instead of failing", async () => {
    expect((await locate("not-a-uuid", ids.sessionA)).statusCode).toBe(404);
  });
});

function userA(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:chat-message-location-a" };
}
