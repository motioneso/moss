import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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

const sportsFiles = [
  "0190a_sports_sources_open_for_upgrade.sql",
  "0191_sports_public_source_runtime.sql",
  "0191a_sports_sources_force_rls.sql"
];
const newsFiles = [
  "0203a_news_sources_open_for_upgrade.sql",
  "0204_news_source_health_states.sql",
  "0218_news_source_kinds.sql",
  "0218a_news_sources_force_rls.sql"
];
const sportsVersions = ["0190a", "0191", "0191a"];
const newsVersions = ["0203a", "0204", "0218", "0218a"];

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
        DROP COLUMN recipe_json, DROP COLUMN recipe_schema_version, DROP COLUMN recipe_fingerprint,
        DROP COLUMN recipe_status, DROP COLUMN confirmed_fetch_hosts,
        DROP COLUMN authorization_confirmed_at;
      ALTER TABLE app.sports_custom_sources FORCE ROW LEVEL SECURITY;
      ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
    `);
    await bootstrap.query("DELETE FROM app.schema_migrations WHERE version = ANY($1)", [
      sportsVersions
    ]);
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
    await bootstrap.query("DELETE FROM app.schema_migrations WHERE version = ANY($1)", [
      newsVersions
    ]);
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

  it("upgrades existing sports sources and keeps row security forced", async () => {
    await rewindSports();
    const { feed, scrape } = await seedSportsSources();

    // Without the unforce step the owner role sees no rows and SET NOT NULL fails.
    await stage("sports", ["0191_sports_public_source_runtime.sql"]);
    await expect(migrate()).rejects.toThrow(/null values/);
    expect(await forced("sports_custom_sources")).toBe(true);

    await stage("sports", sportsFiles);
    await migrate();

    const rows = await bootstrap.query(
      `SELECT id, recipe_status, health_state, confirmed_fetch_hosts,
              authorization_confirmed_at = validated_at AS grandfathered
         FROM app.sports_custom_sources`
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(feed)).toMatchObject({
      recipe_status: "feed",
      confirmed_fetch_hosts: ["feed.example"],
      grandfathered: true
    });
    expect(byId.get(scrape)).toMatchObject({
      recipe_status: "missing",
      health_state: "failing",
      confirmed_fetch_hosts: ["scrape.example"],
      grandfathered: true
    });
    expect(await forced("sports_custom_sources")).toBe(true);
    expect(await forced("sports_source_assignments")).toBe(true);
  });

  it("upgrades existing news sources and keeps row security forced", async () => {
    await rewindNews();
    const id = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at)
       VALUES ($1, $2, 'Paper', 'news.example', 'https://news.example/home',
               'https://feeds.example/rss', 'feed', 'approved', 'unavailable', 'fp', now())`,
      [id, owner]
    );

    // Without the fix the owner role sees no rows and the new CHECK constraints reject them.
    await stage("news", ["0204_news_source_health_states.sql"]);
    await expect(migrate()).rejects.toThrow(/health_status_check/);

    await stage("news", newsFiles);
    await migrate();

    const row = await bootstrap.query(
      "SELECT health_status, confirmed_fetch_hosts, consecutive_failures FROM app.news_custom_sources WHERE id = $1",
      [id]
    );
    expect(row.rows[0]).toMatchObject({
      health_status: "temporarily_unavailable",
      confirmed_fetch_hosts: ["feeds.example", "news.example"],
      consecutive_failures: 0
    });
    expect(await forced("news_custom_sources")).toBe(true);
  });
});
