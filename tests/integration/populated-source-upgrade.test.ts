import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSqlMigrations } from "@moss/db";

import {
  assertIsolatedTestDatabase,
  connectionStrings,
  resetFoundationDatabase
} from "./test-database.js";

const { Client } = pg;

const sportsFile = "0191_sports_public_source_runtime.sql";
const healthFile = "0204_news_source_health_states.sql";
const kindsFile = "0218_news_source_kinds.sql";

// Populated-install upgrade: rows exist before the migrations run, and the migrations run as the
// real migration role (NOBYPASSRLS, subject to FORCE ROW LEVEL SECURITY). A fresh empty database
// cannot show this failure.
describe("populated news and sports source upgrades", () => {
  let bootstrap: pg.Client;
  let directory: string;
  let owner: string;

  beforeEach(async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    await resetFoundationDatabase();
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    directory = await mkdtemp(join(tmpdir(), "populated-source-upgrade-"));
    owner = randomUUID();
    await bootstrap.query("INSERT INTO app.users (id, email) VALUES ($1, $2)", [
      owner,
      `${owner}@example.test`
    ]);
  });

  afterEach(async () => {
    await bootstrap?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function stage(module: "sports" | "news", names: readonly string[]) {
    for (const name of names) {
      await copyFile(join(process.cwd(), `packages/${module}/sql`, name), join(directory, name));
    }
  }

  function migrate() {
    return runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: directory
    });
  }

  async function forced(table: string) {
    const result = await bootstrap.query<{ force: boolean }>(
      "SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = ('app.' || $1)::regclass",
      [table]
    );
    return result.rows[0]?.force;
  }

  // Rewinds the disposable database to the shape before the migrations under test.
  async function rewindSports() {
    await bootstrap.query(`
      DROP TRIGGER IF EXISTS sports_source_assignments_limit ON app.sports_source_assignments;
      ALTER TABLE app.sports_source_assignments
        DROP COLUMN target_url, DROP COLUMN target_parameters, DROP COLUMN preview_status,
        DROP COLUMN health_state, DROP COLUMN health_reason_code, DROP COLUMN health_message,
        DROP COLUMN last_checked_at, DROP COLUMN last_success_at;
      ALTER TABLE app.sports_custom_sources
        DROP CONSTRAINT sports_custom_sources_reason_check,
        DROP COLUMN recipe_json, DROP COLUMN recipe_schema_version, DROP COLUMN recipe_fingerprint,
        DROP COLUMN recipe_status, DROP COLUMN confirmed_fetch_hosts,
        DROP COLUMN authorization_confirmed_at;
      ALTER TABLE app.sports_custom_sources FORCE ROW LEVEL SECURITY;
      ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
    `);
    await bootstrap.query("DELETE FROM app.schema_migrations WHERE version = '0191'");
  }

  async function rewindNews() {
    await bootstrap.query(`
      ALTER TABLE app.news_custom_sources
        DROP COLUMN icon_url, DROP COLUMN confirmed_fetch_hosts, DROP COLUMN consecutive_failures,
        DROP CONSTRAINT news_custom_sources_health_status_check,
        DROP CONSTRAINT news_custom_sources_retrieval_method_check,
        DROP CONSTRAINT news_custom_sources_reddit_shape_check;
      DROP INDEX app.news_custom_sources_owner_domain_unique;
      DROP INDEX app.news_custom_sources_owner_subreddit_unique;
      ALTER TABLE app.news_custom_sources
        ALTER COLUMN health_status DROP DEFAULT,
        ADD CONSTRAINT news_custom_sources_health_status_check
          CHECK (health_status IN ('available', 'unavailable')),
        ADD CONSTRAINT news_custom_sources_retrieval_method_check
          CHECK (retrieval_method IN ('feed', 'scrape')),
        ADD CONSTRAINT news_custom_sources_owner_user_id_canonical_domain_key
          UNIQUE (owner_user_id, canonical_domain);
      ALTER TABLE app.news_custom_sources FORCE ROW LEVEL SECURITY;
    `);
    await bootstrap.query(
      "DELETE FROM app.schema_migrations WHERE version = ANY(ARRAY['0204', '0218'])"
    );
  }

  async function seedSportsSources() {
    const feed = randomUUID();
    const scrape = randomUUID();
    for (const [id, domain, method] of [
      [feed, "feed.example", "feed"],
      [scrape, "scrape.example", "scrape"]
    ] as const) {
      await bootstrap.query(
        `INSERT INTO app.sports_custom_sources
           (id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
            validation_fingerprint, validated_at)
         VALUES ($1, $2, 'Source', $3, $4, $5, $6, 'fp', '2026-01-02T03:04:05Z')`,
        [
          id,
          owner,
          domain,
          `https://${domain}/`,
          method === "feed" ? `https://${domain}/rss` : null,
          method
        ]
      );
    }
    return { feed, scrape };
  }

  async function seedAssignments(sources: { feed: string; scrape: string }) {
    const follow = randomUUID();
    await bootstrap.query(
      "INSERT INTO app.sports_follows (id, owner_user_id, competition_key) VALUES ($1, $2, 'nfl')",
      [follow, owner]
    );
    for (const source of [sources.feed, sources.scrape]) {
      await bootstrap.query(
        `INSERT INTO app.sports_source_assignments (owner_user_id, source_id, follow_id)
         VALUES ($1, $2, $3)`,
        [owner, source, follow]
      );
    }
  }

  async function seedNewsSource() {
    const id = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at)
       VALUES ($1, $2, 'Paper', 'news.example', 'https://news.example/home',
               'https://feeds.example/rss', 'feed', 'approved', 'unavailable', 'fp', now())`,
      [id, owner]
    );
    return id;
  }

  async function expectAllForced() {
    for (const table of [
      "sports_custom_sources",
      "sports_source_assignments",
      "news_custom_sources"
    ]) {
      expect(await forced(table)).toBe(true);
    }
  }

  it("upgrades sports sources and saved assignments, then a second run changes nothing", async () => {
    await rewindSports();
    const sources = await seedSportsSources();
    await seedAssignments(sources);

    await stage("sports", [sportsFile]);
    await migrate();

    const assignments = await bootstrap.query(
      `SELECT source_id, target_url, preview_status, health_state, health_reason_code
         FROM app.sports_source_assignments`
    );
    const bySource = new Map(assignments.rows.map((row) => [row.source_id, row]));
    expect(assignments.rows).toHaveLength(2);
    expect(bySource.get(sources.feed)).toMatchObject({
      target_url: "https://feed.example/rss",
      preview_status: "pending",
      health_state: "pending",
      health_reason_code: null
    });
    expect(bySource.get(sources.scrape)).toMatchObject({
      target_url: null,
      preview_status: "recipe_missing",
      health_state: "failing",
      health_reason_code: "recipe_missing"
    });
    await expectAllForced();

    await migrate();
    const again = await bootstrap.query(
      "SELECT count(*)::int AS n FROM app.sports_source_assignments"
    );
    expect(again.rows[0].n).toBe(2);
    await expectAllForced();
  });

  it("upgrades news sources in two steps and a later run changes nothing", async () => {
    await rewindNews();
    const id = await seedNewsSource();

    // First run stops after 0204, leaving 0218 pending as on a partly upgraded install.
    await stage("news", [healthFile]);
    await migrate();
    const mid = await bootstrap.query(
      "SELECT health_status FROM app.news_custom_sources WHERE id = $1",
      [id]
    );
    expect(mid.rows[0].health_status).toBe("temporarily_unavailable");
    await expectAllForced();

    await stage("news", [kindsFile]);
    await migrate();
    const row = await bootstrap.query(
      "SELECT confirmed_fetch_hosts, consecutive_failures FROM app.news_custom_sources WHERE id = $1",
      [id]
    );
    expect(row.rows[0]).toMatchObject({
      confirmed_fetch_hosts: ["feeds.example", "news.example"],
      consecutive_failures: 0
    });
    await expectAllForced();

    await migrate();
    const count = await bootstrap.query("SELECT count(*)::int AS n FROM app.news_custom_sources");
    expect(count.rows[0].n).toBe(1);
    await expectAllForced();
  });

  it("leaves an already upgraded install untouched", async () => {
    // The foundation reset already applied every migration, so these rows use the current shape.
    const feed = randomUUID();
    const scrape = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.sports_custom_sources
         (id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_fingerprint, validated_at, recipe_status, confirmed_fetch_hosts,
          authorization_confirmed_at)
       VALUES ($1, $3, 'Feed', 'feed.example', 'https://feed.example/', 'https://feed.example/rss',
               'feed', 'fp', now(), 'feed', ARRAY['feed.example'], now()),
              ($2, $3, 'Scrape', 'scrape.example', 'https://scrape.example/', NULL,
               'scrape', 'fp', now(), 'missing', ARRAY['scrape.example'], now())`,
      [feed, scrape, owner]
    );
    await seedAssignments({ feed, scrape });
    const newsId = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, validation_fingerprint, validated_at, confirmed_fetch_hosts)
       VALUES ($1, $2, 'Paper', 'news.example', 'https://news.example/home',
               'https://news.example/rss', 'feed', 'approved', 'fp', now(),
               ARRAY['news.example'])`,
      [newsId, owner]
    );
    const before = await bootstrap.query(
      `SELECT (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app.sports_custom_sources s) AS sports,
              (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM app.sports_source_assignments a) AS assignments,
              (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM app.news_custom_sources n) AS news`
    );

    await stage("sports", [sportsFile]);
    await stage("news", [healthFile, kindsFile]);
    await migrate();
    await migrate();

    const after = await bootstrap.query(
      `SELECT (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app.sports_custom_sources s) AS sports,
              (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM app.sports_source_assignments a) AS assignments,
              (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM app.news_custom_sources n) AS news`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(before.rows[0].sports).toHaveLength(2);
    await expectAllForced();
  });

  it("restores forced row security when a shimmed migration fails, and a retry succeeds", async () => {
    const probe = "9999_shim_probe.sql";
    const unforced = `DO $$ BEGIN
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'app.sports_custom_sources'::regclass) THEN
    RAISE EXCEPTION 'still forced';
  END IF;
END $$;`;
    const shimFor = (sql: string) => ({
      [probe]: {
        checksum: createHash("sha256").update(sql).digest("hex"),
        relaxForcedRls: ["app.sports_custom_sources", "app.sports_source_assignments"]
      }
    });
    const run = (shims: ReturnType<typeof shimFor>) =>
      runSqlMigrations({
        connectionString: connectionStrings.migration,
        migrationsDirectory: directory,
        legacyUpgradeShims: shims
      });

    const failing = `${unforced}\nSELECT 1 / 0;\n`;
    await writeFile(join(directory, probe), failing);
    await expect(run(shimFor(failing))).rejects.toThrow(/division by zero/);
    await expectAllForced();
    const failed = await bootstrap.query(
      "SELECT 1 FROM app.schema_migrations WHERE version = '9999'"
    );
    expect(failed.rows).toHaveLength(0);

    const working = `${unforced}\n`;
    await writeFile(join(directory, probe), working);
    await run(shimFor(working));
    const recorded = await bootstrap.query(
      "SELECT 1 FROM app.schema_migrations WHERE version = '9999'"
    );
    expect(recorded.rows).toHaveLength(1);
    await expectAllForced();
  });
});
