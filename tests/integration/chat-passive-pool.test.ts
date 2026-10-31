import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { ChatUserMemorySettingsRepository, PassiveContextRetriever } from "@moss/chat";
import { GraphMemoryRecallService, StubEmbeddingProvider } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("passive retrieval connection pool (#3606)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("keeps the one-connection pool usable while a timed-out facts search is still embedding", async () => {
    const settings = new ChatUserMemorySettingsRepository();
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      settings.update(scopedDb, ids.userA, { recallEnabled: true, factsEnabled: true })
    );
    let releaseEmbedding!: () => void;
    const embeddingHeld = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    class HeldEmbeddingProvider extends StubEmbeddingProvider {
      override async embedQuery(text: string): Promise<number[]> {
        await embeddingHeld;
        return super.embedQuery(text);
      }
    }
    const retriever = new PassiveContextRetriever({
      dataContext,
      graphRecall: new GraphMemoryRecallService(new HeldEmbeddingProvider())
    });

    try {
      // The passive timeout gives up while the embedding is still held.
      const block = await retriever.retrieve({
        actorUserId: ids.userA,
        userText: "remember House project uses option A for cabinets",
        threadTitle: null,
        recentTurns: []
      });
      expect(block).toBe("");

      // The next turn needs the only connection and the settings row.
      const followUp = dataContext.withDataContext(userAContext(), (scopedDb) =>
        settings.getOrCreate(scopedDb, ids.userA)
      );
      const outcome = await Promise.race([
        followUp.then(() => "served" as const),
        new Promise<"starved">((resolve) => setTimeout(() => resolve("starved"), 2000))
      ]);
      expect(outcome).toBe("served");
    } finally {
      releaseEmbedding();
    }
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-chat-passive-pool"
  };
}
