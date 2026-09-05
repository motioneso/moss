/**
 * Regression test for the history preview tie-break in `ChatRepository.listThreads`
 * (packages/chat/src/repository.ts) — when a saved turn's question and answer share the same
 * timestamp (the normal case: `recordCompletedTurn` stamps both with one `now`), the preview
 * must show the answer, not whichever row a plain "most recent" sort happens to pick first.
 *
 * The unit tests in tests/unit/chat-thread-preview.test.ts only format a body the test hands in
 * directly — they never exercise the database query that selects between the two stored
 * messages, so they cannot catch a regression of this ordering rule. This test goes through the
 * real repository and a real database, the same test-database recipe used by
 * tests/integration/chat-resume-privacy.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { ChatRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("ChatRepository.listThreads preview tie-break", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-chat-thread-preview-tiebreak-secret-key";

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
  });

  afterAll(async () => {
    await appDb?.destroy();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("shows the answer, not the question, when both are saved at the same instant", async () => {
    const threads = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "Tie-break thread" });
      await repository.recordCompletedTurn(
        scopedDb,
        created.id,
        "What is the capital of France?",
        "The capital of France is Paris.",
        { provider: "anthropic", model: "claude-live" }
      );
      return repository.listThreads(scopedDb);
    });

    const thread = threads.find((t) => t.title === "Tie-break thread");
    expect(thread).toBeDefined();
    expect(thread!.lastMessageBody).toBe("The capital of France is Paris.");
  });
});

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:chat-thread-preview-tiebreak-a" };
}
