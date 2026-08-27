import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import type { DatasetClient } from "@moss/datasets";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { HttpError } from "@moss/module-sdk";

import type { NewsImageFetchPort } from "../../packages/news/src/discovery/ports.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";
import { registerNewsRoutes } from "../../packages/news/src/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const feed = `<?xml version="1.0"?><rss><channel><title>Example News</title><item><title>Verified publisher headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

describe("news personalization routes", () => {
  let appDb: Kysely<MossDatabase>;

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  });

  afterEach(async () => {
    await appDb.destroy();
  });

  function buildApp(
    topicAllowed = true,
    image: NewsImageFetchPort = async () => ({ ok: false, reason: "network" }),
    boss: PgBoss | null = null
  ) {
    const app = Fastify();
    registerNewsRoutes(app, {
      dataContext: new DataContextRunner(appDb),
      // #2005: required by the route guard (a declared route must be registered); these
      // tests exercise personalization, not credentials.
      credentialCipher: {
        encrypt: () => ({ version: 1, algorithm: "aes-256-gcm", iv: "", tag: "", ciphertext: "" }),
        decrypt: () => ({ apiKey: "unused" })
      },
      resolveAccessContext: async (request) => {
        if (request.headers.authorization === "none") throw new HttpError(401, "Unauthorized");
        return {
          actorUserId: String(request.headers["x-user-id"] ?? ids.userA),
          requestId: crypto.randomUUID()
        };
      },
      datasetClient: {
        getDataset: async (_key, _params, options) => ({
          data: options.fallback,
          degraded: false,
          fetchedAt: new Date().toISOString()
        })
      } as DatasetClient,
      availability: {
        hasJsonModel: async () => true,
        hasWebSearch: async () => true
      },
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: feed,
          truncated: false
        }),
        image,
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "opaque-test-fingerprint",
          generateJson: async (_db, input) => ({
            ok: true,
            object: input.prompt.includes("news TOPIC")
              ? { allowed: topicAllowed, category: "news_topic" }
              : { allowed: true, category: "news_publisher" }
          })
        }
      },
      boss
    });
    return app;
  }

  it("previews, confirms, and lists a source through real owner-scoped persistence", async () => {
    const app = buildApp();
    await app.ready();
    const preview = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "https://example.com/feed.xml" }
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = JSON.parse(preview.body);
    expect(previewBody.status).toBe("ok");
    expect(preview.body).not.toContain("fingerprint");

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/news/sources",
      payload: { confirmationId: previewBody.confirmationId }
    });
    expect(confirmed.statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(JSON.parse(listed.body).customSources).toEqual([
      expect.objectContaining({ canonicalDomain: "example.com", validationStatus: "approved" })
    ]);
    await app.close();
  });

  it("keeps confirmation IDs owner-scoped", async () => {
    const app = buildApp();
    await app.ready();
    const preview = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "https://example.com/feed.xml" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/news/sources",
      headers: { "x-user-id": ids.userB },
      payload: { confirmationId: JSON.parse(preview.body).confirmationId }
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("default-denies rejected topics without creating a row", async () => {
    const app = buildApp(false);
    await app.ready();
    const create = await app.inject({
      method: "POST",
      url: "/api/news/topics",
      payload: { label: "Rejected topic" }
    });
    expect(create.statusCode).toBe(422);
    const listed = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(JSON.parse(listed.body).customTopics).toEqual([]);
    await app.close();
  });

  it("authorizes cached images only through the current owner's snapshot", async () => {
    const repository = new NewsPersonalizationRepository();
    const dataContext = new DataContextRunner(appDb);
    const publishedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-news-image" },
      (db) =>
        repository.replaceLatestSnapshot(db, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          payload: {
            articles: [
              {
                id: "article-a",
                publisher: "Example News",
                canonicalDomain: "example.com",
                headline: "Owner A headline",
                url: "https://example.com/story",
                publishedAt,
                excerpt: null,
                imageUrl: "https://images.example/lead.png",
                topics: [],
                preferred: true,
                rank: 1
              }
            ]
          }
        })
    );
    let fetches = 0;
    const app = buildApp(true, async () => {
      fetches += 1;
      return {
        ok: true,
        contentType: "image/png",
        body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        truncated: false
      };
    });
    await app.ready();

    const owner = await app.inject({
      method: "GET",
      url: "/api/news/images/article-a",
      headers: { "x-user-id": ids.userA }
    });
    expect(owner.statusCode).toBe(200);
    expect(fetches).toBe(1);

    for (const actorUserId of [ids.userB, ids.adminUser]) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/news/images/article-a",
        headers: { "x-user-id": actorUserId }
      });
      expect(denied.statusCode).toBe(404);
    }
    expect(fetches).toBe(1);

    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "prune-news-image" },
      (db) => repository.pruneSnapshotDomain(db, "example.com")
    );
    const pruned = await app.inject({
      method: "GET",
      url: "/api/news/images/article-a",
      headers: { "x-user-id": ids.userA }
    });
    expect(pruned.statusCode).toBe(404);
    expect(fetches).toBe(1);
    await app.close();
  });

  it("removes a disabled curated source from overview and image routes before refresh", async () => {
    const repository = new NewsPersonalizationRepository();
    const dataContext = new DataContextRunner(appDb);
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-disabled-source" },
      (db) =>
        repository.replaceLatestSnapshot(db, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          payload: {
            articles: [
              {
                id: "bbc-story",
                publisher: "BBC News",
                canonicalDomain: "www.bbc.com",
                headline: "Story removed on disable",
                url: "https://www.bbc.com/news/articles/test",
                publishedAt: new Date(Date.now() - 60_000).toISOString(),
                excerpt: null,
                imageUrl: "https://ichef.bbci.co.uk/test.png",
                topics: [],
                preferred: true,
                rank: 1
              }
            ]
          }
        })
    );
    let fetches = 0;
    const app = buildApp(true, async () => {
      fetches += 1;
      return {
        ok: true,
        contentType: "image/png",
        body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        truncated: false
      };
    });
    await app.ready();

    expect(
      (await app.inject({ method: "GET", url: "/api/news/images/bbc-story" })).statusCode
    ).toBe(200);
    const beforeDisable = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/news/overview" })).body
    );
    expect(beforeDisable.rankedStories).toHaveLength(1);
    expect(beforeDisable.topStories).toHaveLength(1);

    const disabled = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "source_exclude", key: "bbc" }
    });

    expect(disabled.statusCode).toBe(200);
    const afterDisable = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/news/overview" })).body
    );
    expect(afterDisable.rankedStories).toEqual([]);
    expect(afterDisable.topStories).toEqual([]);
    expect(
      (await app.inject({ method: "GET", url: "/api/news/images/bbc-story" })).statusCode
    ).toBe(404);
    expect(fetches).toBe(1);
    await app.close();
  });

  // #975 Slice 4 Task 6 — manual retry endpoint for owners whose sources need attention.
  describe("manual revalidation retry", () => {
    const { Client } = pg;
    let appBoss: PgBoss;
    let bootstrap: pg.Client;

    beforeEach(async () => {
      appBoss = createPgBossClient(connectionStrings.app);
      bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
      await Promise.all([appBoss.start(), bootstrap.connect()]);
    });

    afterEach(async () => {
      await Promise.allSettled([appBoss.stop({ graceful: false }), bootstrap.end()]);
    });

    it("rejects unauthenticated requests with 401", async () => {
      const app = buildApp(true, undefined, appBoss);
      await app.ready();
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/news/revalidation",
          headers: { authorization: "none" }
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("enqueues a revalidation job and reports queued=true through serialization", async () => {
      const app = buildApp(true, undefined, appBoss);
      await app.ready();
      try {
        const res = await app.inject({ method: "POST", url: "/api/news/revalidation" });
        expect(res.statusCode).toBe(202);
        // Full-body equality doubles as the schema-strip check: fast-json-stringify would
        // silently drop `queued` if the response schema didn't declare it.
        expect(JSON.parse(res.body)).toEqual({ queued: true });

        const jobs = await bootstrap.query<{ data: Record<string, unknown> }>(
          `SELECT data FROM pgboss.job WHERE name = 'news.revalidate'`
        );
        expect(jobs.rows).toHaveLength(1);
        expect(jobs.rows[0]!.data).toEqual({
          actorUserId: ids.userA,
          kind: "revalidate",
          idempotencyKey: `news-revalidate:${ids.userA}`
        });
      } finally {
        await app.close();
      }
    });
  });
});
