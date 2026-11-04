import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createNewsProvenanceDiagnosticsProvider } from "@moss/news";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";

const HEADLINE = "Secret headline about the unwanted story";

function article(id: string, domain: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    publisher: "Some Publisher",
    canonicalDomain: domain,
    headline: HEADLINE,
    url: `https://${domain}/${id}`,
    publishedAt: "2026-11-04T10:00:00.000Z",
    excerpt: "Secret excerpt text",
    imageUrl: null,
    topics: [] as string[],
    preferred: true,
    rank: 1,
    ...patch
  };
}

describe("news provenance diagnostics (#3978)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let bootstrap: pg.Client;
  const repository = new NewsPersonalizationRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterAll(async () => {
    await bootstrap.end();
    await appDb.destroy();
  });

  const observe = (actorUserId: string) =>
    dataContext.withDataContext({ actorUserId, requestId: "news-provenance" }, (db) =>
      createNewsProvenanceDiagnosticsProvider(repository).observe(db, {
        actorUserId,
        requestId: "news-provenance"
      })
    );

  it("reports unknown with zero counts when the account has no feed", async () => {
    const result = await observe(ids.userA);
    expect(result).toMatchObject({
      status: "unknown",
      facts: { totalStories: 0, followedTopicCount: 0, excludedSourceCount: 0 }
    });
  });

  it("counts stories by source kind and exclusions, and changes when a source is excluded", async () => {
    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          confirmed_fetch_hosts, validation_status, health_status, validation_fingerprint,
          validated_at)
       VALUES ($1, 'Added One', 'added.example.com', 'https://added.example.com', NULL,
               'scrape', ARRAY['added.example.com'], 'approved', 'healthy', 'fp', now())`,
      [ids.userA]
    );
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-snapshot" },
      async (db) => {
        const generation = await repository.bumpRefreshRequest(db);
        await repository.publishSnapshotIfCurrent(db, generation, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          payload: {
            articles: [
              article("a1", "builtin.example.org", { rank: 1 }),
              article("a2", "builtin.example.org", { rank: 2 }),
              article("a3", "added.example.com", { rank: 3 }),
              article("a4", "search.example.net", { rank: 4, preferred: false })
            ]
          }
        });
      }
    );

    const before = await observe(ids.userA);
    expect(before?.status).toBe("ok");
    expect(before?.facts).toMatchObject({
      totalStories: 4,
      storiesFromBuiltInSources: 3,
      storiesFromAddedSources: 1,
      storiesFoundByTopicSearch: 1,
      storiesMatchingFollowedTopic: 0,
      storiesFromExcludedSources: 0,
      addedSourceCount: 1,
      followedTopicCount: 0,
      excludedSourceCount: 0
    });

    await dataContext.withDataContext({ actorUserId: ids.userA, requestId: "exclude" }, (db) =>
      repository.createExclusion(db, "builtin.example.org")
    );

    const after = await observe(ids.userA);
    expect(after?.facts).toMatchObject({
      excludedSourceCount: 1,
      storiesFromExcludedSources: 2
    });
  });

  it("counts followed topics and stories that matched one", async () => {
    await bootstrap.query(
      `INSERT INTO app.news_custom_topics
         (owner_user_id, label, guidance, validation_status, validation_fingerprint, validated_at)
       VALUES ($1, 'Secret Topic Label', NULL, 'approved', 'fp', now())`,
      [ids.userB]
    );
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "seed-snapshot-b" },
      async (db) => {
        const generation = await repository.bumpRefreshRequest(db);
        await repository.publishSnapshotIfCurrent(db, generation, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          payload: {
            articles: [
              article("b1", "x.example.org", { topics: ["Secret Topic Label"] }),
              article("b2", "x.example.org", { rank: 2 })
            ]
          }
        });
      }
    );

    const result = await observe(ids.userB);
    expect(result?.facts).toMatchObject({
      followedTopicCount: 1,
      storiesMatchingFollowedTopic: 1,
      totalStories: 2
    });
  });

  it("never returns story text, domains or topic labels", async () => {
    for (const actor of [ids.userA, ids.userB]) {
      const text = JSON.stringify(await observe(actor));
      expect(text).not.toContain(HEADLINE);
      expect(text).not.toContain("Secret excerpt");
      expect(text).not.toContain("Secret Topic Label");
      expect(text).not.toContain("example.org");
      expect(text).not.toContain("example.com");
    }
  });

  it("is owner scoped: another account's feed, sources and topics never count", async () => {
    // userA has 4 stories, 1 added source and 1 exclusion; userB has 2 stories and 1 topic.
    const a = await observe(ids.userA);
    const b = await observe(ids.userB);
    expect(a?.facts).toMatchObject({ totalStories: 4, followedTopicCount: 0 });
    expect(b?.facts).toMatchObject({
      totalStories: 2,
      addedSourceCount: 0,
      excludedSourceCount: 0
    });
  });
});
