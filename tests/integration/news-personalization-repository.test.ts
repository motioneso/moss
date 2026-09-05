import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Kysely } from "kysely";
import { createApiServer } from "../../apps/api/src/server.js";
import {
  NEWS_MAX_SOURCE_EXCLUSIONS,
  NewsPersonalizationLimitError,
  NewsPersonalizationRepository
} from "../../packages/news/src/personalization-repository.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  resetFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const { Client } = pg;

// #953 (epic #954) News Slice 1 — schema-level RLS posture for the four personalization
// tables added by 0159_news_personalization.sql. Slice 1 is security-tier: owner-only FORCE
// RLS applies to every actor including admins, and the worker runtime gets NO access until
// Slice 2 proves it needs some. Repository behavior tests (owner isolation via DataContext)
// are added to this file in Task 3.
const PERSONALIZATION_TABLES = [
  "news_custom_sources",
  "news_custom_topics",
  "news_source_exclusions",
  "news_compilation_snapshots"
] as const;

describe("news personalization schema posture (#953)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    await resetFoundationDatabase();
    client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("all four tables exist with ENABLE + FORCE row-level security", async () => {
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...PERSONALIZATION_TABLES]]
    );
    expect(result.rows).toEqual(
      [...PERSONALIZATION_TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true
      }))
    );
  });

  it("defines exactly SELECT/INSERT/UPDATE/DELETE app-runtime policies, all owner-scoped", async () => {
    for (const table of PERSONALIZATION_TABLES) {
      const result = await client.query<{
        policyname: string;
        roles: string[];
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT policyname, roles::text[] AS roles, cmd, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'app' AND tablename = $1
            AND 'jarvis_app_runtime' = ANY(roles)
          ORDER BY cmd`,
        [table]
      );
      expect(result.rows.map((row) => row.cmd).sort(), table).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE"
      ]);
      for (const policy of result.rows) {
        expect(policy.roles, `${table}/${policy.policyname}`).toEqual(["jarvis_app_runtime"]);
        // INSERT policies carry only with_check; SELECT/DELETE only qual; UPDATE both.
        // The invariant: every predicate present is owner-scoped, never simply `true`.
        const predicates = [policy.qual, policy.with_check].filter(
          (predicate): predicate is string => predicate !== null
        );
        expect(predicates.length, `${table}/${policy.policyname}`).toBeGreaterThan(0);
        for (const predicate of predicates) {
          expect(predicate, `${table}/${policy.policyname}`).toContain("owner_user_id");
          expect(predicate, `${table}/${policy.policyname}`).toContain("current_actor_user_id()");
        }
      }
    }
  });

  it("gives the Slice 2 worker only required table-level access", async () => {
    for (const [table, expected] of [
      ["news_custom_sources", [true, false, false, false]],
      ["news_custom_topics", [true, false, false, false]],
      ["news_source_exclusions", [true, false, false, false]],
      ["news_compilation_snapshots", [true, true, true, true]]
    ] as const) {
      const result = await client.query<{ privileges: boolean[] }>(
        `SELECT ARRAY[
           has_table_privilege('jarvis_worker_runtime', $1, 'select'),
           has_table_privilege('jarvis_worker_runtime', $1, 'insert'),
           has_table_privilege('jarvis_worker_runtime', $1, 'update'),
           has_table_privilege('jarvis_worker_runtime', $1, 'delete')
         ] AS privileges`,
        [`app.${table}`]
      );
      expect(result.rows[0]?.privileges, table).toEqual(expected);
    }
  });

  it("app runtime holds exactly SELECT/INSERT/UPDATE/DELETE and never owns the tables", async () => {
    for (const table of PERSONALIZATION_TABLES) {
      const grants = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE table_schema = 'app' AND table_name = $1 AND grantee = 'jarvis_app_runtime'
          ORDER BY privilege_type`,
        [table]
      );
      expect(
        grants.rows.map((row) => row.privilege_type),
        table
      ).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);

      const owner = await client.query<{ tableowner: string }>(
        `SELECT tableowner FROM pg_tables WHERE schemaname = 'app' AND tablename = $1`,
        [table]
      );
      expect(owner.rows[0]?.tableowner, table).toBe("jarvis_migration_owner");
    }
  });

  it("news_custom_topics enforces case-insensitive owner+label uniqueness via expression index", async () => {
    const result = await client.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = 'news_custom_topics'
          AND indexdef ILIKE '%lower(label)%'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain("UNIQUE");
    expect(result.rows[0]?.indexdef).toContain("owner_user_id");
  });
});

// Task 3 — repository behavior under each actor's DataContext GUC. Mirrors
// news-prefs-repository.test.ts: real API server for sign-up so users exist, then the
// repository is exercised directly so RLS + the SQL-enforced cap are the things under test.
// Slice 2 owns custom source/topic writes, so those rows are seeded via the bootstrap
// superuser connection (the only actor that bypasses FORCE RLS by design).
describe("news personalization repository (#953 Task 3)", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataCtx: DataContextRunner;
  let bootstrap: pg.Client;
  const repo = new NewsPersonalizationRepository();

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return res.json<{ user: { id: string } }>().user.id;
  }

  /** First sign-up is the instance admin/owner; RLS must isolate them like anyone else. */
  async function signUpAdminAliceBob(prefix: string): Promise<[string, string, string]> {
    const admin = await signUp("Admin", `${prefix}-admin@example.com`);
    await setInstanceSetting("registration.requires_approval", { value: false });
    const alice = await signUp("Alice", `${prefix}-alice@example.com`);
    const bob = await signUp("Bob", `${prefix}-bob@example.com`);
    return [admin, alice, bob];
  }

  function asActor<T>(
    actorUserId: string,
    requestId: string,
    fn: (scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
  ): Promise<T> {
    return dataCtx.withDataContext({ actorUserId, requestId }, fn);
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
    dataCtx = new DataContextRunner(appDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      bootstrap?.end(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("exclusions are owner-isolated: neither another user nor the admin can see or delete them", async () => {
    const [admin, alice, bob] = await signUpAdminAliceBob("np-excl");

    const created = await asActor(alice, "np-1a", (scopedDb) =>
      repo.createExclusion(scopedDb, "tabloid.example.com")
    );
    expect(created.canonicalDomain).toBe("tabloid.example.com");

    const aliceList = await asActor(alice, "np-1b", (scopedDb) => repo.listExclusions(scopedDb));
    expect(aliceList.map((e) => e.id)).toEqual([created.id]);

    for (const [actor, tag] of [
      [bob, "np-1c"],
      [admin, "np-1d"]
    ] as const) {
      const list = await asActor(actor, tag, (scopedDb) => repo.listExclusions(scopedDb));
      expect(list).toEqual([]);
      const removed = await asActor(actor, `${tag}-rm`, (scopedDb) =>
        repo.removeExclusion(scopedDb, created.id)
      );
      expect(removed).toBe(false);
    }

    // The row must have survived both foreign delete attempts.
    const stillThere = await asActor(alice, "np-1e", (scopedDb) => repo.listExclusions(scopedDb));
    expect(stillThere).toHaveLength(1);

    const ownRemoved = await asActor(alice, "np-1f", (scopedDb) =>
      repo.removeExclusion(scopedDb, created.id)
    );
    expect(ownRemoved).toBe(true);
  });

  it("duplicate exclusion create is idempotent (same row back, no duplicate)", async () => {
    const [, alice] = await signUpAdminAliceBob("np-dup");

    const first = await asActor(alice, "np-2a", (scopedDb) =>
      repo.createExclusion(scopedDb, "dup.example.com")
    );
    const second = await asActor(alice, "np-2b", (scopedDb) =>
      repo.createExclusion(scopedDb, "dup.example.com")
    );
    expect(second.id).toBe(first.id);

    const listed = await asActor(alice, "np-2c", (scopedDb) => repo.listExclusions(scopedDb));
    expect(listed).toHaveLength(1);
  });

  it("the exclusion over the cap fails with the typed limit error; duplicates at cap stay idempotent", async () => {
    const [, alice, bob] = await signUpAdminAliceBob("np-cap");

    // Seed to exactly the cap via the superuser (fast path; the cap guard itself is
    // SQL-side and actor-scoped, which the repo call below exercises).
    await bootstrap.query(
      `INSERT INTO app.news_source_exclusions (owner_user_id, canonical_domain)
       SELECT $1, 'seeded-' || i || '.example.com' FROM generate_series(1, $2::int) AS i`,
      [alice, NEWS_MAX_SOURCE_EXCLUSIONS]
    );

    await expect(
      asActor(alice, "np-3a", (scopedDb) => repo.createExclusion(scopedDb, "overflow.example.com"))
    ).rejects.toBeInstanceOf(NewsPersonalizationLimitError);

    // Re-adding an existing domain at the cap returns the existing row, not an error.
    const dup = await asActor(alice, "np-3b", (scopedDb) =>
      repo.createExclusion(scopedDb, "seeded-1.example.com")
    );
    expect(dup.canonicalDomain).toBe("seeded-1.example.com");

    // The cap is per-owner: Alice being full must not block Bob.
    const bobCreated = await asActor(bob, "np-3c", (scopedDb) =>
      repo.createExclusion(scopedDb, "overflow.example.com")
    );
    expect(bobCreated.canonicalDomain).toBe("overflow.example.com");
  });

  it("custom sources and topics list/count only the actor's rows and never expose fingerprints", async () => {
    const [admin, alice, bob] = await signUpAdminAliceBob("np-src");

    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at)
       VALUES ($1, 'The Example Times', 'news.example.com', 'https://news.example.com', NULL,
               'scrape', 'approved', 'healthy', 'fp-secret-marker', now())`,
      [alice]
    );
    await bootstrap.query(
      `INSERT INTO app.news_custom_topics
         (owner_user_id, label, guidance, validation_status, validation_fingerprint, validated_at)
       VALUES ($1, 'AI Safety', 'focus on policy', 'approved', 'fp-secret-marker', now())`,
      [alice]
    );

    const sources = await asActor(alice, "np-4a", (scopedDb) => repo.listCustomSources(scopedDb));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.canonicalDomain).toBe("news.example.com");
    // DTO must omit the opaque revalidation marker entirely (not just null it).
    expect(JSON.stringify(sources)).not.toContain("fingerprint");
    expect(JSON.stringify(sources)).not.toContain("fp-secret-marker");

    const topics = await asActor(alice, "np-4b", (scopedDb) => repo.listCustomTopics(scopedDb));
    expect(topics).toHaveLength(1);
    expect(topics[0]?.label).toBe("AI Safety");
    expect(JSON.stringify(topics)).not.toContain("fingerprint");
    expect(JSON.stringify(topics)).not.toContain("fp-secret-marker");

    expect(await asActor(alice, "np-4c", (scopedDb) => repo.countCustomSources(scopedDb))).toBe(1);
    expect(await asActor(alice, "np-4d", (scopedDb) => repo.countCustomTopics(scopedDb))).toBe(1);

    for (const [actor, tag] of [
      [bob, "np-4e"],
      [admin, "np-4f"]
    ] as const) {
      expect(await asActor(actor, tag, (scopedDb) => repo.listCustomSources(scopedDb))).toEqual([]);
      expect(
        await asActor(actor, `${tag}-t`, (scopedDb) => repo.listCustomTopics(scopedDb))
      ).toEqual([]);
      expect(
        await asActor(actor, `${tag}-cs`, (scopedDb) => repo.countCustomSources(scopedDb))
      ).toBe(0);
      expect(
        await asActor(actor, `${tag}-ct`, (scopedDb) => repo.countCustomTopics(scopedDb))
      ).toBe(0);
    }
  });

  it("snapshot replace is an atomic per-owner upsert and reads are owner-isolated", async () => {
    const [admin, alice, bob] = await signUpAdminAliceBob("np-snap");

    const first = {
      compiledAt: new Date("2026-07-11T06:00:00Z"),
      expiresAt: new Date("2026-07-11T12:00:00Z"),
      payload: {
        articles: [
          {
            id: "first",
            publisher: "Example",
            canonicalDomain: "example.com",
            headline: "First",
            url: "https://example.com/1",
            publishedAt: "2026-07-11T05:00:00.000Z",
            excerpt: null,
            imageUrl: null,
            topics: [],
            preferred: true,
            rank: 1
          }
        ]
      }
    };
    await asActor(alice, "np-5a", (scopedDb) => repo.replaceLatestSnapshot(scopedDb, first));

    const read = await asActor(alice, "np-5b", (scopedDb) => repo.readLatestSnapshot(scopedDb));
    expect(read?.compiledAt.toISOString()).toBe("2026-07-11T06:00:00.000Z");
    expect(read?.payload).toEqual(first.payload);

    // Replace again: still exactly one row for Alice, with the new content.
    const second = {
      compiledAt: new Date("2026-07-11T07:00:00Z"),
      expiresAt: new Date("2026-07-11T13:00:00Z"),
      payload: { articles: [] }
    };
    await asActor(alice, "np-5c", (scopedDb) => repo.replaceLatestSnapshot(scopedDb, second));
    const reread = await asActor(alice, "np-5d", (scopedDb) => repo.readLatestSnapshot(scopedDb));
    expect(reread?.compiledAt.toISOString()).toBe("2026-07-11T07:00:00.000Z");
    expect(reread?.payload).toEqual({ articles: [] });

    const rowCount = await bootstrap.query(
      `SELECT count(*)::int AS n FROM app.news_compilation_snapshots WHERE owner_user_id = $1`,
      [alice]
    );
    expect(rowCount.rows[0]?.n).toBe(1);

    for (const [actor, tag] of [
      [bob, "np-5e"],
      [admin, "np-5f"]
    ] as const) {
      expect(await asActor(actor, tag, (scopedDb) => repo.readLatestSnapshot(scopedDb))).toBeNull();
    }
  });

  it("replaceLatestSnapshot rejects an invalid payload before SQL (stored row untouched)", async () => {
    const [, alice] = await signUpAdminAliceBob("np-guard");

    const good = {
      compiledAt: new Date("2026-07-11T06:00:00Z"),
      expiresAt: new Date("2026-07-11T12:00:00Z"),
      payload: { articles: [] }
    };
    await asActor(alice, "np-6a", (scopedDb) => repo.replaceLatestSnapshot(scopedDb, good));

    await expect(
      asActor(alice, "np-6b", (scopedDb) =>
        repo.replaceLatestSnapshot(scopedDb, {
          ...good,
          compiledAt: new Date("2026-07-11T08:00:00Z"),
          payload: { articles: {} } // articles must be an array
        })
      )
    ).rejects.toThrow(/articles/);

    const read = await asActor(alice, "np-6c", (scopedDb) => repo.readLatestSnapshot(scopedDb));
    expect(read?.compiledAt.toISOString()).toBe("2026-07-11T06:00:00.000Z");
  });
});

// #975 (epic #954) News Slice 4 — validation-state reads/writes used by the provider-change
// revalidation worker. Writes run under the WORKER role's DataContext to prove the 0161
// column-scoped grants plus owner-scoped RLS policies allow exactly the owner's rows and
// nothing more. Every cross-owner/admin negative is paired with an owner positive control.
describe("news validation state repository (#975 Slice 4)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataCtx: DataContextRunner;
  let workerCtx: DataContextRunner;
  let bootstrap: pg.Client;
  const repo = new NewsPersonalizationRepository();

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return res.json<{ user: { id: string } }>().user.id;
  }

  /** First sign-up is the instance admin/owner; RLS must isolate them like anyone else. */
  async function signUpAdminAliceBob(prefix: string): Promise<[string, string, string]> {
    const admin = await signUp("Admin", `${prefix}-admin@example.com`);
    await setInstanceSetting("registration.requires_approval", { value: false });
    const alice = await signUp("Alice", `${prefix}-alice@example.com`);
    const bob = await signUp("Bob", `${prefix}-bob@example.com`);
    return [admin, alice, bob];
  }

  function asActor<T>(
    runner: DataContextRunner,
    actorUserId: string,
    requestId: string,
    fn: (scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
  ): Promise<T> {
    return runner.withDataContext({ actorUserId, requestId }, fn);
  }

  /** Seeds one source + one topic for the owner with a stale fingerprint and old timestamps. */
  async function seedValidationRows(
    ownerId: string
  ): Promise<{ sourceId: string; topicId: string }> {
    const source = await bootstrap.query<{ id: string }>(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at, updated_at)
       VALUES ($1, 'The Example Times', 'news.example.com', 'https://news.example.com', NULL,
               'scrape', 'approved', 'healthy', 'fp-old', now() - interval '1 day',
               now() - interval '1 day')
       RETURNING id`,
      [ownerId]
    );
    const topic = await bootstrap.query<{ id: string }>(
      `INSERT INTO app.news_custom_topics
         (owner_user_id, label, guidance, validation_status, validation_fingerprint,
          validated_at, updated_at)
       VALUES ($1, 'AI Safety', 'focus on policy', 'approved', 'fp-old',
               now() - interval '1 day', now() - interval '1 day')
       RETURNING id`,
      [ownerId]
    );
    return { sourceId: source.rows[0]!.id, topicId: topic.rows[0]!.id };
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
    dataCtx = new DataContextRunner(appDb);
    workerCtx = new DataContextRunner(workerDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      workerDb?.destroy(),
      bootstrap?.end(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("owner lists their own validation states (fingerprint included); others and admin get none", async () => {
    const [admin, alice, bob] = await signUpAdminAliceBob("nv-list");
    const { sourceId, topicId } = await seedValidationRows(alice);

    const sources = await asActor(dataCtx, alice, "nv-1a", (scopedDb) =>
      repo.listSourceValidationStates(scopedDb)
    );
    expect(sources).toEqual([
      {
        id: sourceId,
        label: "The Example Times",
        canonicalDomain: "news.example.com",
        homepageUrl: "https://news.example.com",
        feedUrl: null,
        retrievalMethod: "scrape",
        validationStatus: "approved",
        validationFingerprint: "fp-old",
        healthStatus: "healthy"
      }
    ]);

    const topics = await asActor(dataCtx, alice, "nv-1b", (scopedDb) =>
      repo.listTopicValidationStates(scopedDb)
    );
    expect(topics).toEqual([
      {
        id: topicId,
        label: "AI Safety",
        guidance: "focus on policy",
        validationStatus: "approved",
        validationFingerprint: "fp-old"
      }
    ]);

    // Cross-owner and admin reads must both come back empty (RLS applies to admins too).
    for (const [actor, tag] of [
      [bob, "nv-1c"],
      [admin, "nv-1d"]
    ] as const) {
      expect(
        await asActor(dataCtx, actor, tag, (scopedDb) => repo.listSourceValidationStates(scopedDb))
      ).toEqual([]);
      expect(
        await asActor(dataCtx, actor, `${tag}-t`, (scopedDb) =>
          repo.listTopicValidationStates(scopedDb)
        )
      ).toEqual([]);
    }
  });

  it("worker updates source validation for its own actor and bumps validated_at/updated_at", async () => {
    const [, alice] = await signUpAdminAliceBob("nv-src");
    const { sourceId } = await seedValidationRows(alice);

    await asActor(workerCtx, alice, "nv-2a", (scopedDb) =>
      repo.updateSourceValidation(scopedDb, sourceId, {
        validationStatus: "needs_revalidation",
        validationFingerprint: "fp-new"
      })
    );

    const row = await bootstrap.query<{
      validation_status: string;
      validation_fingerprint: string;
      validated_recent: boolean;
      updated_recent: boolean;
    }>(
      `SELECT validation_status, validation_fingerprint,
              validated_at > now() - interval '1 minute' AS validated_recent,
              updated_at > now() - interval '1 minute' AS updated_recent
         FROM app.news_custom_sources WHERE id = $1`,
      [sourceId]
    );
    expect(row.rows[0]).toEqual({
      validation_status: "needs_revalidation",
      validation_fingerprint: "fp-new",
      validated_recent: true,
      updated_recent: true
    });
  });

  it("worker updates topic validation for its own actor and bumps validated_at/updated_at", async () => {
    const [, alice] = await signUpAdminAliceBob("nv-top");
    const { topicId } = await seedValidationRows(alice);

    await asActor(workerCtx, alice, "nv-3a", (scopedDb) =>
      repo.updateTopicValidation(scopedDb, topicId, {
        validationStatus: "rejected",
        validationFingerprint: "fp-new"
      })
    );

    const row = await bootstrap.query<{
      validation_status: string;
      validation_fingerprint: string;
      validated_recent: boolean;
      updated_recent: boolean;
    }>(
      `SELECT validation_status, validation_fingerprint,
              validated_at > now() - interval '1 minute' AS validated_recent,
              updated_at > now() - interval '1 minute' AS updated_recent
         FROM app.news_custom_topics WHERE id = $1`,
      [topicId]
    );
    expect(row.rows[0]).toEqual({
      validation_status: "rejected",
      validation_fingerprint: "fp-new",
      validated_recent: true,
      updated_recent: true
    });
  });

  it("worker writes are owner-scoped: acting as another user leaves the row untouched", async () => {
    const [, alice, bob] = await signUpAdminAliceBob("nv-cross");
    const { sourceId, topicId } = await seedValidationRows(alice);

    // Worker running Bob's job must not be able to touch Alice's rows by id.
    await asActor(workerCtx, bob, "nv-4a", (scopedDb) =>
      repo.updateSourceValidation(scopedDb, sourceId, {
        validationStatus: "rejected",
        validationFingerprint: "fp-evil"
      })
    );
    await asActor(workerCtx, bob, "nv-4b", (scopedDb) =>
      repo.updateTopicValidation(scopedDb, topicId, {
        validationStatus: "rejected",
        validationFingerprint: "fp-evil"
      })
    );

    const source = await bootstrap.query<{ validation_status: string; fp: string }>(
      `SELECT validation_status, validation_fingerprint AS fp
         FROM app.news_custom_sources WHERE id = $1`,
      [sourceId]
    );
    expect(source.rows[0]).toEqual({ validation_status: "approved", fp: "fp-old" });
    const topic = await bootstrap.query<{ validation_status: string; fp: string }>(
      `SELECT validation_status, validation_fingerprint AS fp
         FROM app.news_custom_topics WHERE id = $1`,
      [topicId]
    );
    expect(topic.rows[0]).toEqual({ validation_status: "approved", fp: "fp-old" });

    // Positive control: the same worker connection acting as Alice CAN update her rows.
    await asActor(workerCtx, alice, "nv-4c", (scopedDb) =>
      repo.updateSourceValidation(scopedDb, sourceId, {
        validationStatus: "approved",
        validationFingerprint: "fp-new"
      })
    );
    const after = await bootstrap.query<{ fp: string }>(
      `SELECT validation_fingerprint AS fp FROM app.news_custom_sources WHERE id = $1`,
      [sourceId]
    );
    expect(after.rows[0]?.fp).toBe("fp-new");
  });
});

// #2282 — migration 0218 adds subreddit sources (retrieval_method 'reddit'), a per-source
// confirmed fetch-host allowlist, an https-only icon URL, and a bounded workaround failure
// count. Every case here fails if the matching constraint, index or grant is missing.
describe("news source kinds schema (#2282 migration 0218)", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let dataCtx: DataContextRunner;
  let bootstrap: pg.Client;
  const repo = new NewsPersonalizationRepository();

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return res.json<{ user: { id: string } }>().user.id;
  }

  async function signUpAliceBob(prefix: string): Promise<[string, string]> {
    await signUp("Admin", `${prefix}-admin@example.com`);
    await setInstanceSetting("registration.requires_approval", { value: false });
    const alice = await signUp("Alice", `${prefix}-alice@example.com`);
    const bob = await signUp("Bob", `${prefix}-bob@example.com`);
    return [alice, bob];
  }

  function asActor<T>(
    actorUserId: string,
    requestId: string,
    fn: (scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
  ): Promise<T> {
    return dataCtx.withDataContext({ actorUserId, requestId }, fn);
  }

  interface SourceSeed {
    readonly label: string;
    readonly canonicalDomain: string;
    readonly homepageUrl: string;
    readonly feedUrl: string | null;
    readonly retrievalMethod: string;
    readonly iconUrl: string | null;
    readonly confirmedFetchHosts: readonly string[];
  }

  const publication: SourceSeed = {
    label: "The Example Times",
    canonicalDomain: "news.example.com",
    homepageUrl: "https://news.example.com",
    feedUrl: "https://news.example.com/feed",
    retrievalMethod: "feed",
    iconUrl: null,
    confirmedFetchHosts: ["news.example.com"]
  };

  function subreddit(name: string): SourceSeed {
    return {
      label: `r/${name}`,
      canonicalDomain: "reddit.com",
      homepageUrl: `https://www.reddit.com/r/${name}/`,
      feedUrl: `https://www.reddit.com/r/${name}/hot.rss`,
      retrievalMethod: "reddit",
      iconUrl: null,
      confirmedFetchHosts: ["www.reddit.com"]
    };
  }

  /** Raw superuser insert: exercises the table's own constraints, not the repository. */
  async function insertSource(ownerId: string, seed: SourceSeed): Promise<string> {
    const result = await bootstrap.query<{ id: string }>(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          icon_url, confirmed_fetch_hosts, validation_status, health_status,
          validation_fingerprint, validated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', 'healthy', 'fp-0218', now())
       RETURNING id`,
      [
        ownerId,
        seed.label,
        seed.canonicalDomain,
        seed.homepageUrl,
        seed.feedUrl,
        seed.retrievalMethod,
        seed.iconUrl,
        [...seed.confirmedFetchHosts]
      ]
    );
    return result.rows[0]!.id;
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
    dataCtx = new DataContextRunner(appDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      bootstrap?.end(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("accepts a subreddit row and rejects the reddit method on a non-Reddit shape", async () => {
    const [alice] = await signUpAliceBob("nk-shape");
    await expect(insertSource(alice, subreddit("nfl"))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      insertSource(alice, { ...publication, retrievalMethod: "reddit" })
    ).rejects.toThrow(/news_custom_sources_reddit_shape_check/);
    await expect(insertSource(alice, { ...subreddit("nba"), feedUrl: null })).rejects.toThrow(
      /news_custom_sources_reddit_shape_check/
    );
  });

  it("icon_url must be an https URL when present", async () => {
    const [alice] = await signUpAliceBob("nk-icon");
    await expect(
      insertSource(alice, { ...publication, iconUrl: "http://news.example.com/icon.png" })
    ).rejects.toThrow(/news_custom_sources_icon_url_check/);
    await expect(
      insertSource(alice, { ...publication, iconUrl: "https://news.example.com/icon.png" })
    ).resolves.toBeTruthy();
  });

  it("confirmed_fetch_hosts rejects an empty list, uppercase hosts, and more than eight", async () => {
    const [alice] = await signUpAliceBob("nk-hosts");
    await expect(insertSource(alice, { ...publication, confirmedFetchHosts: [] })).rejects.toThrow(
      /news_custom_sources_confirmed_fetch_hosts_check/
    );
    await expect(
      insertSource(alice, { ...publication, confirmedFetchHosts: ["News.Example.com"] })
    ).rejects.toThrow(/news_custom_sources_confirmed_fetch_hosts_check/);
    await expect(
      insertSource(alice, {
        ...publication,
        confirmedFetchHosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.com`)
      })
    ).rejects.toThrow(/news_custom_sources_confirmed_fetch_hosts_check/);
    await expect(
      insertSource(alice, {
        ...publication,
        confirmedFetchHosts: ["news.example.com", "cdn.example.net"]
      })
    ).resolves.toBeTruthy();
  });

  it("consecutive_failures starts at 0 and cannot exceed 3", async () => {
    const [alice] = await signUpAliceBob("nk-count");
    const id = await insertSource(alice, publication);
    const before = await bootstrap.query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM app.news_custom_sources WHERE id = $1`,
      [id]
    );
    expect(before.rows[0]?.consecutive_failures).toBe(0);
    await expect(
      bootstrap.query(`UPDATE app.news_custom_sources SET consecutive_failures = 4 WHERE id = $1`, [
        id
      ])
    ).rejects.toThrow(/news_custom_sources_consecutive_failures_check/);
  });

  it("two owners may each follow one subreddit; one owner cannot hold r/nfl and r/NFL", async () => {
    const [alice, bob] = await signUpAliceBob("nk-sub");
    await insertSource(alice, subreddit("nfl"));
    await expect(insertSource(bob, subreddit("nfl"))).resolves.toBeTruthy();
    await expect(insertSource(alice, subreddit("NFL"))).rejects.toThrow(
      /news_custom_sources_owner_subreddit_unique/
    );
    // Two different subreddits share canonical_domain 'reddit.com' for one owner without clashing.
    await expect(insertSource(alice, subreddit("nba"))).resolves.toBeTruthy();
  });

  it("a publication domain still collides for one owner", async () => {
    const [alice, bob] = await signUpAliceBob("nk-domain");
    await insertSource(alice, publication);
    await expect(insertSource(alice, { ...publication, label: "Again" })).rejects.toThrow(
      /news_custom_sources_owner_domain_unique/
    );
    await expect(insertSource(bob, publication)).resolves.toBeTruthy();
  });

  it("another owner's subreddit row is invisible under RLS", async () => {
    const [alice, bob] = await signUpAliceBob("nk-rls");
    await insertSource(alice, subreddit("nfl"));
    const bobs = await asActor(bob, "nk-rls-b", (scopedDb) => repo.listCustomSources(scopedDb));
    expect(bobs).toEqual([]);
    const alices = await asActor(alice, "nk-rls-a", (scopedDb) => repo.listCustomSources(scopedDb));
    expect(alices).toHaveLength(1);
    expect(alices[0]?.retrievalMethod).toBe("reddit");
  });

  it("the worker may update the failure count with health, and nothing else new", async () => {
    await signUpAliceBob("nk-grant");
    const result = await bootstrap.query<{ privileges: boolean[] }>(
      `SELECT ARRAY[
         has_column_privilege('jarvis_worker_runtime', 'app.news_custom_sources',
                              'consecutive_failures', 'update'),
         has_column_privilege('jarvis_worker_runtime', 'app.news_custom_sources',
                              'health_status', 'update'),
         has_column_privilege('jarvis_worker_runtime', 'app.news_custom_sources',
                              'icon_url', 'update'),
         has_column_privilege('jarvis_worker_runtime', 'app.news_custom_sources',
                              'confirmed_fetch_hosts', 'update')
       ] AS privileges`
    );
    expect(result.rows[0]?.privileges).toEqual([true, true, false, false]);
  });
});
