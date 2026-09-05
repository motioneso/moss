import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import {
  enqueueNewsRefresh,
  NEWS_REFRESH_QUEUE,
  registerNewsJobWorkers
} from "../../packages/news/src/jobs.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

function feedFor(url: string): string {
  const host = new URL(url).hostname;
  const publisher = host.includes("bbci")
    ? "www.bbc.com"
    : host.includes("guardian")
      ? "www.theguardian.com"
      : "www.npr.org";
  return `<?xml version="1.0"?><rss><channel><item><title>Current story from ${publisher}</title><link>https://${publisher}/story</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
}

describe("news refresh jobs", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let bootstrap: pg.Client;
  const repository = new NewsPersonalizationRepository();

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    appContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    appBoss = createPgBossClient(connectionStrings.app);
    workerBoss = createPgBossClient(connectionStrings.worker);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await Promise.all([appBoss.start(), workerBoss.start(), bootstrap.connect()]);
  });

  afterEach(async () => {
    await Promise.allSettled([
      appBoss.stop({ graceful: false }),
      workerBoss.stop({ graceful: false }),
      appDb.destroy(),
      workerDb.destroy(),
      bootstrap.end()
    ]);
  });

  const asActor = <T>(work: (db: DataContextDb) => Promise<T>) =>
    appContext.withDataContext({ actorUserId: ids.userA, requestId: crypto.randomUUID() }, work);

  async function waitForIdle(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await asActor((db) => repository.readRefreshState(db));
      if (state.state === "idle" || state.state === "failed") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("news refresh worker did not finish");
  }

  it("coalesces queued work while preserving every generation and a metadata-only payload", async () => {
    await asActor((db) => repository.bumpRefreshRequest(db));
    await expect(enqueueNewsRefresh(appBoss, ids.userA)).resolves.toBe(true);
    await asActor((db) => repository.bumpRefreshRequest(db));
    await expect(enqueueNewsRefresh(appBoss, ids.userA)).resolves.toBe(false);

    const queued = await bootstrap.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND state = 'created'`,
      [NEWS_REFRESH_QUEUE]
    );
    expect(queued.rows).toHaveLength(1);
    expect(Object.keys(queued.rows[0]!.data).sort()).toEqual([
      "actorUserId",
      "idempotencyKey",
      "kind"
    ]);
    await expect(
      bootstrap.query(
        `SELECT requested_generation FROM app.news_refresh_state WHERE owner_user_id = $1`,
        [ids.userA]
      )
    ).resolves.toMatchObject({ rows: [{ requested_generation: "2" }] });

    await registerNewsJobWorkers(workerBoss, workerContext, {
      fetchWithOptions: async () => ({ ok: false, reason: "network" }),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: "application/rss+xml",
        body: feedFor(url),
        truncated: false
      }),
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "fp",
        generateJson: async (_db, input) => ({
          ok: true,
          object: {
            rankings: [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match, index) => ({
              id: match[1],
              relevance: 100 - index,
              eligible: true
            }))
          }
        })
      },
      logger: { info: () => undefined }
    });
    await waitForIdle();
    await expect(asActor((db) => repository.readRefreshState(db))).resolves.toMatchObject({
      state: "idle"
    });
    await expect(asActor((db) => repository.readLatestSnapshot(db))).resolves.toMatchObject({
      payload: { articles: expect.any(Array) }
    });
  });

  it("records an attempt and a success when a worker run finishes", async () => {
    await asActor((db) => repository.bumpRefreshRequest(db));
    await enqueueNewsRefresh(appBoss, ids.userA);
    await registerNewsJobWorkers(workerBoss, workerContext, {
      fetchWithOptions: async () => ({ ok: false, reason: "network" }),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: "application/rss+xml",
        body: feedFor(url),
        truncated: false
      }),
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "fp",
        generateJson: async (_db, input) => ({
          ok: true,
          object: {
            rankings: [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match, index) => ({
              id: match[1],
              relevance: 100 - index,
              eligible: true
            }))
          }
        })
      },
      logger: { info: () => undefined }
    });
    await waitForIdle();

    const state = await asActor((db) => repository.readRefreshState(db));
    expect(state.state).toBe("idle");
    expect(state.lastRequestedAt).not.toBeNull();
    expect(state.lastAttemptAt).not.toBeNull();
    expect(state.lastSuccessAt).not.toBeNull();
    expect(state.lastFailureAt).toBeNull();
    expect(state.lastFailureKind).toBeNull();
  });

  it("records an attempt and a fetch failure when every source fails, keeping the stored feed", async () => {
    // The failure write runs as the WORKER role in a fresh data context, because the job's own
    // transaction has already failed (#1590). If the new history columns were not writable there,
    // this is the test that catches it.
    await asActor(async (db) => {
      await repository.bumpRefreshRequest(db);
      const generation = await repository.beginRefreshRun(db);
      await repository.publishSnapshotIfCurrent(db, generation, {
        compiledAt: new Date("2026-07-11T10:00:00.000Z"),
        expiresAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: {
          articles: [
            {
              id: "last-good",
              publisher: "Example",
              canonicalDomain: "example.com",
              headline: "Last good story",
              url: "https://example.com/story",
              publishedAt: "2026-07-11T09:00:00.000Z",
              excerpt: null,
              imageUrl: null,
              topics: [],
              preferred: true,
              rank: 1
            }
          ]
        }
      });
      await repository.bumpRefreshRequest(db);
    });
    const beforeRun = await asActor((db) => repository.readRefreshState(db));

    await enqueueNewsRefresh(appBoss, ids.userA);
    await registerNewsJobWorkers(workerBoss, workerContext, {
      fetchWithOptions: async () => ({ ok: false, reason: "network" }),
      fetch: async () => ({ ok: false as const, reason: "network" as const, status: 503 }),
      search: { search: async () => ({ results: [] }) },
      ai: { fingerprint: async () => "fp", generateJson: async () => ({ ok: true, object: {} }) },
      logger: { info: () => undefined, warn: () => undefined }
    });
    await waitForIdle();

    const state = await asActor((db) => repository.readRefreshState(db));
    expect(state.state).toBe("failed");
    expect(state.failureKind).toBe("fetch");
    expect(state.lastFailureKind).toBe("fetch");
    expect(state.lastFailureAt).not.toBeNull();
    expect(state.lastAttemptAt).not.toBeNull();
    expect(state.lastAttemptAt! > beforeRun.lastAttemptAt!).toBe(true);
    // The last good feed is left exactly where it was.
    expect(state.lastSuccessAt).toBe(beforeRun.lastSuccessAt);
    await expect(asActor((db) => repository.readLatestSnapshot(db))).resolves.toMatchObject({
      payload: { articles: [{ headline: "Last good story" }] }
    });
  });

  it("publishes a deterministic snapshot and records an AI fallback warning", async () => {
    const warnings: Record<string, unknown>[] = [];
    await asActor(async (db) => {
      await repository.bumpRefreshRequest(db);
      const generation = await repository.beginRefreshRun(db);
      await repository.publishSnapshotIfCurrent(db, generation, {
        compiledAt: new Date("2026-07-11T10:00:00.000Z"),
        expiresAt: new Date("2026-07-18T10:00:00.000Z"),
        payload: {
          articles: [
            {
              id: "last-good",
              publisher: "Example",
              canonicalDomain: "example.com",
              headline: "Last good story",
              url: "https://example.com/story",
              publishedAt: "2026-07-11T09:00:00.000Z",
              excerpt: null,
              imageUrl: null,
              topics: [],
              preferred: true,
              rank: 1
            }
          ]
        }
      });
      await repository.bumpRefreshRequest(db);
    });
    await enqueueNewsRefresh(appBoss, ids.userA);
    await registerNewsJobWorkers(workerBoss, workerContext, {
      fetchWithOptions: async () => ({ ok: false, reason: "network" }),
      fetch: async (url) => ({
        ok: true,
        status: 200,
        finalUrl: url,
        contentType: "application/rss+xml",
        body: feedFor(url),
        truncated: false
      }),
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "fp",
        generateJson: async () => ({ ok: false, error: "provider_error" })
      },
      logger: {
        info: () => undefined,
        warn: (fields) => warnings.push(fields)
      }
    });
    await waitForIdle();
    await expect(asActor((db) => repository.readRefreshState(db))).resolves.toMatchObject({
      state: "idle"
    });
    await expect(asActor((db) => repository.readLatestSnapshot(db))).resolves.toMatchObject({
      payload: {
        articles: expect.arrayContaining([
          expect.objectContaining({ headline: expect.stringContaining("Current story") })
        ])
      }
    });
    expect(warnings).toEqual([
      {
        event: "news_compile_ai_fallback",
        aiError: "provider_error",
        candidateCount: expect.any(Number)
      }
    ]);
  });
});
