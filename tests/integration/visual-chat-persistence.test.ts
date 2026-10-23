import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>;
let runner: DataContextRunner;
const repository = new ChatRepository();
const owner = { actorUserId: ids.userA };
const executed = { provider: "anthropic" as const, model: "offline-fixture" };
const persistence = () =>
  new DataContextChatPersistence({
    dataContext: runner,
    chatRepository: repository,
    aiRepository: new AiRepository()
  });

function visual(threadId: string, turnId: string) {
  const service = new VisualPresentationService();
  const identity = { actorUserId: ids.userA, threadId, turnId };
  const turn = service.begin("test", identity);
  const context = turn.registerPrompt('{"hours":6}', new Date().toISOString());
  const input = JSON.parse(context.split("Worked tool input: ")[1]!).proposal;
  const result = service.present({ ...identity, chatSessionId: "test", requestId: "test" }, input);
  if (!result.ok) throw new Error(result.code);
  return result.reply;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  runner = new DataContextRunner(app);
});
afterAll(async () => app?.destroy());

describe("visual reply transaction and portable history", () => {
  it("rolls back the real inserted messages and visual when Stop arrives during save", async () => {
    const thread = await runner.withDataContext(owner, (db) =>
      repository.openNewThread(db, { title: "Stopped visual" })
    );
    const turnId = randomUUID();
    const stop = new AbortController();
    const original = repository.recordCompletedTurn.bind(repository);
    const spy = vi
      .spyOn(repository, "recordCompletedTurn")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        expect(result?.assistantMessage.tool_metadata.visualReplyV1).toBeDefined();
        stop.abort();
        return result;
      });
    try {
      await expect(
        persistence().recordTurn(ids.userA, "hours", "Six hours.", executed, {
          threadId: thread.id,
          turnId,
          visualReply: visual(thread.id, turnId),
          stopSignal: stop.signal
        })
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(
      await runner.withDataContext(owner, (db) => repository.listMessages(db, thread.id))
    ).toEqual([]);
  });

  it("archives readable facts, deletes them with the thread and never saves private visuals", async () => {
    const thread = await runner.withDataContext(owner, (db) =>
      repository.openNewThread(db, { title: "Saved visual" })
    );
    const turnId = randomUUID();
    const reply = visual(thread.id, turnId);
    await persistence().recordTurn(ids.userA, "hours", "Six hours.", executed, {
      threadId: thread.id,
      turnId,
      visualReply: reply
    });
    const readArchive = () =>
      runner.withDataContext(owner, (db) =>
        repository.listStoredMessagesInRange(
          db,
          ids.userA,
          "2000-01-01T00:00:00Z",
          "2100-01-01T00:00:00Z"
        )
      );
    const archived = (await readArchive()).find(
      (message) => message.threadId === thread.id && message.role === "assistant"
    );
    expect(archived?.body).toContain("Six hours.");
    expect(archived?.body).toContain(reply.fallbackText);
    expect(archived?.body).not.toContain("root =");
    await runner.withDataContext(owner, (db) => repository.deleteThread(db, thread.id));
    expect((await readArchive()).some((message) => message.threadId === thread.id)).toBe(false);
    const privateThread = await runner.withDataContext(owner, (db) =>
      repository.openNewThread(db, { title: "Private", incognito: true })
    );
    expect(
      await persistence().recordTurn(ids.userA, "private hours", "Six hours.", executed, {
        threadId: privateThread.id,
        turnId,
        visualReply: reply
      })
    ).toBeUndefined();
    expect(
      await runner.withDataContext(owner, (db) => repository.listMessages(db, privateThread.id))
    ).toEqual([]);
  });
});
