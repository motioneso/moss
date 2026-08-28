import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createNewsDiagnosticsProvider } from "@moss/news";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";

describe("news diagnostics provider", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const repository = new NewsPersonalizationRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  const observe = (actorUserId: string) =>
    dataContext.withDataContext({ actorUserId, requestId: "news-diagnostics" }, (db) =>
      createNewsDiagnosticsProvider(repository).observe(db, {
        actorUserId,
        requestId: "news-diagnostics"
      })
    );

  it("reports unknown before the first refresh", async () => {
    await expect(observe(ids.userA)).resolves.toMatchObject({ status: "unknown" });
  });

  it("keeps failure history after a later successful refresh", async () => {
    const failedGeneration = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "failure" },
      async (db) => {
        await repository.bumpRefreshRequest(db);
        const generation = await repository.beginRefreshRun(db);
        return generation;
      }
    );
    await repository.failRefreshRunIfCurrent(
      dataContext,
      { actorUserId: ids.userA, requestId: "failure" },
      failedGeneration,
      "fetch"
    );
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "success" },
      async (db) => {
        const generation = await repository.bumpRefreshRequest(db);
        await repository.publishSnapshotIfCurrent(db, generation, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          payload: {
            articles: [
              {
                id: "private-article",
                publisher: "Example Publisher",
                canonicalDomain: "example.test",
                headline: "private article title",
                url: "https://example.test/private-article",
                publishedAt: "2026-08-27T10:00:00.000Z",
                excerpt: null,
                imageUrl: null,
                topics: [],
                preferred: true,
                rank: 1
              }
            ]
          }
        });
      }
    );

    const result = await observe(ids.userA);
    expect(result).toMatchObject({ status: "ok", facts: { lastFailureKind: "fetch" } });
    expect(JSON.stringify(result)).not.toContain("private article title");
  });

  it("reports a snapshot older than a day as degraded with its item count", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "stale" },
      async (db) => {
        const generation = await repository.bumpRefreshRequest(db);
        await repository.publishSnapshotIfCurrent(db, generation, {
          compiledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          payload: {
            articles: [
              {
                id: "stale-one",
                publisher: "Example Publisher",
                canonicalDomain: "example.test",
                headline: "stale private title",
                url: "https://example.test/stale-one",
                publishedAt: "2026-08-27T10:00:00.000Z",
                excerpt: null,
                imageUrl: null,
                topics: [],
                preferred: true,
                rank: 1
              },
              {
                id: "stale-two",
                publisher: "Example Publisher",
                canonicalDomain: "example.test",
                headline: "another title",
                url: "https://example.test/stale-two",
                publishedAt: "2026-08-27T10:00:00.000Z",
                excerpt: null,
                imageUrl: null,
                topics: [],
                preferred: true,
                rank: 2
              }
            ]
          }
        });
      }
    );

    const result = await observe(ids.userB);
    expect(result).toMatchObject({ status: "degraded", facts: { itemCount: 2 } });
    expect(JSON.stringify(result)).not.toContain("stale private title");
  });
});
