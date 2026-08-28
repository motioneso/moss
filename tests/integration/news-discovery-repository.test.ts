import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { sql, type Kysely } from "kysely";

import {
  NEWS_MAX_CUSTOM_TOPICS,
  NEWS_MAX_CUSTOM_SOURCES,
  NewsDuplicateSourceError,
  NewsPersonalizationLimitError,
  NewsPersonalizationRepository
} from "../../packages/news/src/personalization-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
const repo = new NewsPersonalizationRepository();

/** What readRefreshState returns for an owner who has never asked for a refresh. */
const EMPTY_REFRESH_STATE = {
  state: "idle",
  updatedAt: null,
  lastRequestedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureKind: null
} as const;

const article = (id: string, headline: string, rank: number) => ({
  id,
  publisher: "News Example",
  canonicalDomain: "news.example.com",
  headline,
  url: `https://news.example.com/${id}`,
  publishedAt: "2026-07-11T11:00:00.000Z",
  excerpt: null,
  imageUrl: null,
  topics: [] as string[],
  preferred: true,
  rank
});

describe("news discovery repository", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let bootstrap: pg.Client;

  const asActor = <T>(actorUserId: string, fn: (db: DataContextDb) => Promise<T>): Promise<T> =>
    dataContext.withDataContext({ actorUserId, requestId: crypto.randomUUID() }, fn);

  const sourceInput = (index: number) => ({
    label: `Publisher ${index}`,
    canonicalDomain: `publisher-${index}.example.com`,
    homepageUrl: `https://publisher-${index}.example.com`,
    feedUrl: null,
    retrievalMethod: "scrape" as const,
    validationFingerprint: "opaque-fingerprint"
  });

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([appDb.destroy(), bootstrap.end()]);
  });

  it("enables and forces RLS on refresh state and policy verdicts", async () => {
    const result = await bootstrap.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE nspname = 'app' AND relname = ANY($1) ORDER BY relname`,
      [["news_policy_verdicts", "news_refresh_state"]]
    );
    expect(result.rows).toEqual([
      { relname: "news_policy_verdicts", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "news_refresh_state", relrowsecurity: true, relforcerowsecurity: true }
    ]);
  });

  it("creates, replaces, deletes, caps, and owner-isolates sources", async () => {
    const created = await asActor(ids.userA, (db) => repo.createCustomSource(db, sourceInput(1)));
    expect(created).toMatchObject({ canonicalDomain: "publisher-1.example.com" });
    expect(JSON.stringify(created)).not.toContain("fingerprint");
    await expect(
      asActor(ids.userA, (db) => repo.createCustomSource(db, sourceInput(1)))
    ).rejects.toBeInstanceOf(NewsDuplicateSourceError);
    await expect(
      asActor(ids.userB, (db) => repo.replaceCustomSource(db, created.id, sourceInput(2)))
    ).resolves.toBeNull();
    await expect(asActor(ids.userB, (db) => repo.deleteCustomSource(db, created.id))).resolves.toBe(
      false
    );

    for (let index = 2; index <= NEWS_MAX_CUSTOM_SOURCES; index += 1) {
      await asActor(ids.userA, (db) => repo.createCustomSource(db, sourceInput(index)));
    }
    await expect(
      asActor(ids.userA, (db) => repo.createCustomSource(db, sourceInput(99)))
    ).rejects.toBeInstanceOf(NewsPersonalizationLimitError);
  });

  it("writes topics with case-insensitive uniqueness and owner isolation", async () => {
    const topic = await asActor(ids.userA, (db) =>
      repo.createCustomTopic(db, {
        label: "AI Safety",
        guidance: "Policy",
        validationFingerprint: "opaque-fingerprint"
      })
    );
    await expect(
      asActor(ids.userA, (db) =>
        repo.createCustomTopic(db, {
          label: "ai safety",
          guidance: null,
          validationFingerprint: "opaque-fingerprint"
        })
      )
    ).rejects.toThrow();
    await expect(
      asActor(ids.userB, (db) =>
        repo.updateCustomTopic(db, topic.id, { label: "Changed", guidance: null })
      )
    ).resolves.toBeNull();
    await expect(asActor(ids.userB, (db) => repo.deleteCustomTopic(db, topic.id))).resolves.toBe(
      false
    );
    for (let index = 2; index <= NEWS_MAX_CUSTOM_TOPICS; index += 1) {
      await asActor(ids.userA, (db) =>
        repo.createCustomTopic(db, {
          label: `Topic ${index}`,
          guidance: null,
          validationFingerprint: "opaque-fingerprint"
        })
      );
    }
    await expect(
      asActor(ids.userA, (db) =>
        repo.createCustomTopic(db, {
          label: "Topic 11",
          guidance: null,
          validationFingerprint: "opaque-fingerprint"
        })
      )
    ).rejects.toBeInstanceOf(NewsPersonalizationLimitError);
  });

  it("scopes and expires provider-policy verdicts", async () => {
    await asActor(ids.userA, (db) =>
      repo.upsertPolicyVerdict(db, {
        canonicalDomain: "publisher.example.com",
        fingerprint: "fp-a",
        verdict: "approved",
        ttlMs: 60_000
      })
    );
    await expect(
      asActor(ids.userA, (db) => repo.readPolicyVerdict(db, "publisher.example.com", "fp-a"))
    ).resolves.toBe("approved");
    await expect(
      asActor(ids.userA, (db) => repo.readPolicyVerdict(db, "publisher.example.com", "fp-b"))
    ).resolves.toBeNull();
    await expect(
      asActor(ids.userB, (db) => repo.readPolicyVerdict(db, "publisher.example.com", "fp-a"))
    ).resolves.toBeNull();
    await bootstrap.query(
      `UPDATE app.news_policy_verdicts SET expires_at = now() - interval '1 second'`
    );
    await expect(
      asActor(ids.userA, (db) => repo.readPolicyVerdict(db, "publisher.example.com", "fp-a"))
    ).resolves.toBeNull();
  });

  it("uses generations to reject stale publication and atomically prunes domains", async () => {
    await expect(asActor(ids.userA, (db) => repo.readRefreshState(db))).resolves.toEqual(
      EMPTY_REFRESH_STATE
    );
    await expect(asActor(ids.userA, (db) => repo.bumpRefreshRequest(db))).resolves.toBe(1);
    const generation = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    await expect(asActor(ids.userA, (db) => repo.bumpRefreshRequest(db))).resolves.toBe(2);
    const snapshot = {
      compiledAt: new Date("2026-07-11T12:00:00Z"),
      expiresAt: new Date("2026-07-11T12:30:00Z"),
      payload: {
        articles: [
          {
            id: "one",
            publisher: "News Example",
            canonicalDomain: "news.example.com",
            headline: "One",
            url: "https://news.example.com/one",
            publishedAt: "2026-07-11T11:00:00.000Z",
            excerpt: null,
            imageUrl: null,
            topics: [],
            preferred: true,
            rank: 1
          },
          {
            id: "two",
            publisher: "Other",
            canonicalDomain: "other.test",
            headline: "Two",
            url: "https://other.test/two",
            publishedAt: "2026-07-11T10:00:00.000Z",
            excerpt: null,
            imageUrl: null,
            topics: [],
            preferred: false,
            rank: 2
          }
        ]
      }
    };
    await expect(
      asActor(ids.userA, (db) => repo.publishSnapshotIfCurrent(db, generation, snapshot))
    ).resolves.toBe(false);
    const current = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    await expect(
      asActor(ids.userA, (db) => repo.publishSnapshotIfCurrent(db, current, snapshot))
    ).resolves.toBe(true);
    await asActor(ids.userA, (db) => repo.pruneSnapshotDomain(db, "example.com"));
    await expect(asActor(ids.userA, (db) => repo.readLatestSnapshot(db))).resolves.toMatchObject({
      payload: { articles: [{ canonicalDomain: "other.test", headline: "Two" }] }
    });
    await expect(asActor(ids.userB, (db) => repo.readRefreshState(db))).resolves.toEqual(
      EMPTY_REFRESH_STATE
    );
  });

  it("records requests, attempts, successes and failures as four separate facts", async () => {
    // The point of #2030: state/failure_kind say what is true RIGHT NOW and are wiped by the next
    // run, so once the state returns to idle a run that failed and a run that succeeded look
    // identical. The five history columns must survive that wipe.
    const history = () => asActor(ids.userA, (db) => repo.readRefreshState(db));
    const accessContext = { actorUserId: ids.userA, requestId: crypto.randomUUID() };
    const snapshot = (compiledAt: Date) => ({
      compiledAt,
      expiresAt: new Date(compiledAt.getTime() + 30 * 60_000),
      payload: { articles: [article("one", "One", 1)] }
    });

    await expect(history()).resolves.toEqual(EMPTY_REFRESH_STATE);

    // 1. Request. Only last_requested_at moves; nothing else has happened yet.
    await expect(asActor(ids.userA, (db) => repo.bumpRefreshRequest(db))).resolves.toBe(1);
    const requested = await history();
    expect(requested.lastRequestedAt).not.toBeNull();
    expect(requested.lastAttemptAt).toBeNull();
    expect(requested.lastSuccessAt).toBeNull();
    expect(requested.lastFailureAt).toBeNull();
    expect(requested.lastFailureKind).toBeNull();

    // 2. Attempt. last_attempt_at appears; the request time is left exactly where it was.
    const firstRun = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    const attempted = await history();
    expect(attempted.lastAttemptAt).not.toBeNull();
    expect(attempted.lastRequestedAt).toBe(requested.lastRequestedAt);
    expect(attempted.lastSuccessAt).toBeNull();
    expect(attempted.lastFailureAt).toBeNull();

    // 3. Success. last_success_at appears; request and attempt times are untouched.
    await expect(
      asActor(ids.userA, (db) => repo.publishSnapshotIfCurrent(db, firstRun, snapshot(new Date())))
    ).resolves.toBe(true);
    const succeeded = await history();
    expect(succeeded.state).toBe("idle");
    expect(succeeded.lastSuccessAt).not.toBeNull();
    expect(succeeded.lastRequestedAt).toBe(requested.lastRequestedAt);
    expect(succeeded.lastAttemptAt).toBe(attempted.lastAttemptAt);
    expect(succeeded.lastFailureAt).toBeNull();

    // 4. A second request and attempt. Both must move PAST the success that happened in between —
    // if the ON CONFLICT branch of either write forgot its timestamp, the old value would still
    // sit before last_success_at and these two comparisons would fail.
    await expect(asActor(ids.userA, (db) => repo.bumpRefreshRequest(db))).resolves.toBe(2);
    const rerequested = await history();
    expect(rerequested.lastRequestedAt! > succeeded.lastSuccessAt!).toBe(true);
    expect(rerequested.lastSuccessAt).toBe(succeeded.lastSuccessAt);

    const secondRun = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    expect(secondRun).toBe(2);
    const reattempted = await history();
    expect(reattempted.lastAttemptAt! > succeeded.lastSuccessAt!).toBe(true);
    expect(reattempted.lastSuccessAt).toBe(succeeded.lastSuccessAt);

    // 5. Failure. The kind is stored in both the live column and the history column.
    await expect(
      repo.failRefreshRunIfCurrent(dataContext, accessContext, secondRun, "fetch")
    ).resolves.toBe(true);
    const failed = await history();
    expect(failed.state).toBe("failed");
    expect(failed.failureKind).toBe("fetch");
    expect(failed.lastFailureKind).toBe("fetch");
    expect(failed.lastFailureAt! > succeeded.lastSuccessAt!).toBe(true);
    expect(failed.lastSuccessAt).toBe(succeeded.lastSuccessAt);

    // 6. The rule this whole slice exists for: a later success clears the LIVE failure_kind but
    // must leave the failure history exactly as it was.
    await expect(asActor(ids.userA, (db) => repo.bumpRefreshRequest(db))).resolves.toBe(3);
    const thirdRun = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    await expect(
      asActor(ids.userA, (db) => repo.publishSnapshotIfCurrent(db, thirdRun, snapshot(new Date())))
    ).resolves.toBe(true);
    const recovered = await history();
    expect(recovered.state).toBe("idle");
    expect(recovered.failureKind).toBeUndefined();
    expect(recovered.lastFailureAt).toBe(failed.lastFailureAt);
    expect(recovered.lastFailureKind).toBe("fetch");
    expect(recovered.lastSuccessAt! > failed.lastFailureAt!).toBe(true);
  });

  it("reports feed freshness and item count without ever loading the feed", async () => {
    // With no snapshot at all: no age to report, and nothing in the feed.
    const empty = await asActor(ids.userA, (db) => repo.readRefreshDiagnostics(db));
    expect(empty).toEqual({
      refresh: EMPTY_REFRESH_STATE,
      requestedGeneration: 0,
      compiledGeneration: 0,
      snapshotCompiledAt: null,
      snapshotExpiresAt: null,
      snapshotAgeSeconds: null,
      itemCount: 0
    });

    await asActor(ids.userA, (db) => repo.bumpRefreshRequest(db));
    const generation = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    const compiledAt = new Date();
    await expect(
      asActor(ids.userA, (db) =>
        repo.publishSnapshotIfCurrent(db, generation, {
          compiledAt,
          expiresAt: new Date(compiledAt.getTime() + 30 * 60_000),
          payload: {
            articles: [
              article("one", "Secret headline one", 1),
              article("two", "Secret headline two", 2),
              article("three", "Secret headline three", 3)
            ]
          }
        })
      )
    ).resolves.toBe(true);

    const filled = await asActor(ids.userA, (db) => repo.readRefreshDiagnostics(db));
    expect(filled.itemCount).toBe(3);
    expect(filled.snapshotCompiledAt).toBe(compiledAt.toISOString());
    expect(filled.snapshotAgeSeconds).not.toBeNull();
    expect(filled.snapshotAgeSeconds!).toBeGreaterThanOrEqual(0);
    expect(filled.snapshotAgeSeconds!).toBeLessThan(120);
    expect(filled.requestedGeneration).toBe(1);
    expect(filled.compiledGeneration).toBe(1);
    expect(filled.refresh.lastSuccessAt).not.toBeNull();

    // The count is computed inside Postgres, so no article text may ride along in the result.
    const serialized = JSON.stringify(filled);
    expect(serialized).not.toContain("Secret headline");
    expect(serialized).not.toContain("articles");
  });

  it("keeps one owner's refresh history invisible to another owner", async () => {
    await asActor(ids.userA, (db) => repo.bumpRefreshRequest(db));
    const run = await asActor<number>(ids.userA, (db) => repo.beginRefreshRun(db));
    await repo.failRefreshRunIfCurrent(
      dataContext,
      { actorUserId: ids.userA, requestId: crypto.randomUUID() },
      run,
      "ai"
    );

    // The second owner has their own empty history, and their own diagnostics read shows nothing
    // of the first owner's failed run.
    await expect(asActor(ids.userB, (db) => repo.readRefreshState(db))).resolves.toEqual(
      EMPTY_REFRESH_STATE
    );
    await expect(
      asActor(ids.userB, (db) => repo.readRefreshDiagnostics(db))
    ).resolves.toMatchObject({
      refresh: EMPTY_REFRESH_STATE,
      itemCount: 0,
      snapshotAgeSeconds: null
    });

    // Naming the new columns explicitly must not let the second owner rewrite the first owner's
    // history, and a direct read of that row must return nothing.
    await asActor(ids.userB, async (scopedDb) => {
      const overwrite = await scopedDb.db
        .updateTable("app.news_refresh_state")
        .set({ last_failure_kind: null, last_failure_at: null, last_success_at: new Date() })
        .where("owner_user_id", "=", ids.userA)
        .executeTakeFirst();
      expect(overwrite.numUpdatedRows).toBe(0n);
      await expect(
        sql`SELECT last_failure_kind, last_failure_at FROM app.news_refresh_state
             WHERE owner_user_id = ${ids.userA}`.execute(scopedDb.db)
      ).resolves.toMatchObject({ rows: [] });
    });

    const untouched = await asActor(ids.userA, (db) => repo.readRefreshState(db));
    expect(untouched.lastFailureKind).toBe("ai");
    expect(untouched.lastFailureAt).not.toBeNull();
    expect(untouched.lastSuccessAt).toBeNull();
  });

  it("new-table RLS denies cross-owner updates and deletes", async () => {
    await asActor(ids.userA, (db) => repo.bumpRefreshRequest(db));
    await asActor(ids.userA, (db) =>
      repo.upsertPolicyVerdict(db, {
        canonicalDomain: "private.example",
        fingerprint: "fp",
        verdict: "approved",
        ttlMs: 60_000
      })
    );
    await asActor(ids.userB, async (scopedDb) => {
      const refreshUpdate = await scopedDb.db
        .updateTable("app.news_refresh_state")
        .set({ state: "failed" })
        .where("owner_user_id", "=", ids.userA)
        .executeTakeFirst();
      const refreshDelete = await scopedDb.db
        .deleteFrom("app.news_refresh_state")
        .where("owner_user_id", "=", ids.userA)
        .executeTakeFirst();
      const verdictUpdate = await scopedDb.db
        .updateTable("app.news_policy_verdicts")
        .set({ verdict: "rejected" })
        .where("owner_user_id", "=", ids.userA)
        .executeTakeFirst();
      const verdictDelete = await scopedDb.db
        .deleteFrom("app.news_policy_verdicts")
        .where("owner_user_id", "=", ids.userA)
        .executeTakeFirst();
      expect(refreshUpdate.numUpdatedRows).toBe(0n);
      expect(refreshDelete.numDeletedRows).toBe(0n);
      expect(verdictUpdate.numUpdatedRows).toBe(0n);
      expect(verdictDelete.numDeletedRows).toBe(0n);
      await expect(
        sql`SELECT 1 FROM app.news_refresh_state WHERE owner_user_id = ${ids.userA}`.execute(
          scopedDb.db
        )
      ).resolves.toMatchObject({ rows: [] });
    });
    await expect(asActor(ids.userA, (db) => repo.readRefreshState(db))).resolves.toMatchObject({
      state: "queued"
    });
    await expect(
      asActor(ids.userA, (db) => repo.readPolicyVerdict(db, "private.example", "fp"))
    ).resolves.toBe("approved");
  });

  it("worker reads only its own curated news preferences", async () => {
    await bootstrap.query(
      `INSERT INTO app.news_prefs (owner_user_id, kind, key)
       VALUES ($1, 'source', 'bbc'), ($2, 'source', 'guardian')`,
      [ids.userA, ids.userB]
    );
    await bootstrap.query("SET ROLE jarvis_worker_runtime");
    await bootstrap.query("SELECT set_config('app.actor_user_id', $1, false)", [ids.userA]);
    const result = await bootstrap.query(
      `SELECT owner_user_id, key FROM app.news_prefs ORDER BY key`
    );
    expect(result.rows).toEqual([{ owner_user_id: ids.userA, key: "bbc" }]);
  });

  // Since migration 0161 (#975 Slice 4) the worker's UPDATE grant is health_status plus the
  // revalidation columns (validation_status, validation_fingerprint, validated_at, updated_at)
  // — those are positively covered owner-scoped in news-personalization-repository.test.ts.
  // This test keeps the negative controls: identity columns stay worker-unwritable.
  it("worker column grant permits health but never identity columns on same-owner source rows", async () => {
    const created = await asActor(ids.userA, (db) => repo.createCustomSource(db, sourceInput(1)));
    await bootstrap.query("SET ROLE jarvis_worker_runtime");
    await bootstrap.query("SELECT set_config('app.actor_user_id', $1, false)", [ids.userA]);
    const changed = await bootstrap.query(
      `UPDATE app.news_custom_sources SET health_status = 'temporarily_unavailable' WHERE id = $1`,
      [created.id]
    );
    expect(changed.rowCount).toBe(1);
    for (const statement of [
      "label = 'Changed'",
      "homepage_url = 'https://changed.example'",
      "feed_url = 'https://changed.example/feed'",
      "owner_user_id = owner_user_id"
    ]) {
      await expect(
        bootstrap.query(`UPDATE app.news_custom_sources SET ${statement} WHERE id = $1`, [
          created.id
        ])
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("worker RLS hides and prevents updates to another owner's rows", async () => {
    const other = await asActor(ids.userB, (db) => repo.createCustomSource(db, sourceInput(1)));
    await bootstrap.query("SET ROLE jarvis_worker_runtime");
    await bootstrap.query("SELECT set_config('app.actor_user_id', $1, false)", [ids.userA]);
    const visible = await bootstrap.query(`SELECT id FROM app.news_custom_sources WHERE id = $1`, [
      other.id
    ]);
    expect(visible.rows).toEqual([]);
    const changed = await bootstrap.query(
      `UPDATE app.news_custom_sources SET health_status = 'temporarily_unavailable' WHERE id = $1`,
      [other.id]
    );
    expect(changed.rowCount).toBe(0);
  });
});
