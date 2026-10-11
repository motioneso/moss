import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadMigrationFiles, runSqlMigrations } from "@moss/db";

import {
  assertIsolatedTestDatabase,
  connectionStrings,
  resetFoundationDatabase
} from "./test-database.js";

const schema = "sql_backfill_fixture";
const sqlName = "0001_transaction.sql";
const sidecarName = "0001_transaction.backfill.mjs";
const migrationSql = `-- moss:backfill ${sidecarName}
ALTER TABLE ${schema}.existing ADD COLUMN projected text;
CREATE TABLE ${schema}.projection (id integer PRIMARY KEY, value text NOT NULL);
ALTER TABLE ${schema}.projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.projection FORCE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.existing NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.projection NO FORCE ROW LEVEL SECURITY;
`;
const sidecar = `export async function backfill(client) {
  await client.query("UPDATE ${schema}.existing SET attempts = attempts + 1, projected = 'migrated'");
  await client.query("INSERT INTO ${schema}.projection (id, value) SELECT id, value FROM ${schema}.existing");
  const result = await client.query("SELECT should_fail FROM ${schema}.control");
  if (result.rows[0].should_fail) throw new Error("PRIVATE_SYNTHETIC_FAILURE_VALUE");
  await client.query("ALTER TABLE ${schema}.existing FORCE ROW LEVEL SECURITY");
  await client.query("ALTER TABLE ${schema}.projection FORCE ROW LEVEL SECURITY");
}`;

// Run only through the supported isolated integration gate. This fixture never creates roles,
// grants runtime privileges, or rewinds a checked-in migration or an application table.
describe("transactional first-party migration sidecars", () => {
  let bootstrap: pg.Client;
  let directory: string;

  beforeEach(async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    assertIsolatedTestDatabase(connectionStrings.migration);
    await resetFoundationDatabase();
    bootstrap = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    directory = await mkdtemp(join(tmpdir(), "moss-backfill-integration-"));
    await writeFile(join(directory, sqlName), migrationSql);
    await writeFile(join(directory, sidecarName), sidecar);
    const owner = new pg.Client({ connectionString: connectionStrings.migration });
    await owner.connect();
    try {
      await owner.query(`
        CREATE SCHEMA ${schema};
        CREATE TABLE ${schema}.existing (
          id integer PRIMARY KEY, value text NOT NULL, attempts integer NOT NULL DEFAULT 0
        );
        INSERT INTO ${schema}.existing (id, value) VALUES (1, 'original synthetic value');
        ALTER TABLE ${schema}.existing ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${schema}.existing FORCE ROW LEVEL SECURITY;
        CREATE TABLE ${schema}.control (should_fail boolean NOT NULL);
        INSERT INTO ${schema}.control VALUES (true);
      `);
    } finally {
      await owner.end();
    }
  });

  afterEach(async () => {
    try {
      if (bootstrap) await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await bootstrap?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  function migrate() {
    return runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: directory,
      migrationsSchema: schema
    });
  }

  async function expectForcedRls(table: string) {
    const result = await bootstrap.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
      [`${schema}.${table}`]
    );
    expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  }

  async function assertRolledBack() {
    expect((await bootstrap.query(`SELECT * FROM ${schema}.existing`)).rows).toEqual([
      { id: 1, value: "original synthetic value", attempts: 0 }
    ]);
    const projection = await bootstrap.query("SELECT to_regclass($1) AS table_name", [
      `${schema}.projection`
    ]);
    expect(projection.rows).toEqual([{ table_name: null }]);
    expect((await bootstrap.query(`SELECT * FROM ${schema}.schema_migrations`)).rows).toEqual([]);
    await expectForcedRls("existing");
  }

  it("rolls back DDL, data, FORCE mode and ledger on failure, then restarts exactly once", async () => {
    const [file] = await loadMigrationFiles(directory);
    await expect(migrate()).rejects.toThrow(`Migration backfill ${sidecarName} failed`);
    await assertRolledBack();

    // The fixture changes only the transient failure condition. Retry uses identical migration
    // bytes in fresh clients, and two contenders must serialize on the canonical advisory lock.
    await bootstrap.query(`UPDATE ${schema}.control SET should_fail = false`);
    const retries = await Promise.all([migrate(), migrate()]);
    expect(retries.flatMap((result) => result.applied)).toHaveLength(1);
    expect(retries.flatMap((result) => result.skipped)).toHaveLength(1);
    expect((await bootstrap.query(`SELECT * FROM ${schema}.existing`)).rows).toEqual([
      { id: 1, value: "original synthetic value", attempts: 1, projected: "migrated" }
    ]);
    expect((await bootstrap.query(`SELECT * FROM ${schema}.projection`)).rows).toEqual([
      { id: 1, value: "original synthetic value" }
    ]);
    expect(
      (await bootstrap.query(`SELECT version, checksum FROM ${schema}.schema_migrations`)).rows
    ).toEqual([{ version: "0001", checksum: file!.checksum }]);
    await expectForcedRls("existing");
    await expectForcedRls("projection");
    expect(
      (
        await bootstrap.query(
          `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = $1`,
          [schema]
        )
      ).rows
    ).toEqual([{ count: 0 }]);

    // An applied replay must not reach the callback, even when it would now throw.
    await bootstrap.query(`UPDATE ${schema}.control SET should_fail = true`);
    const replay = await migrate();
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toHaveLength(1);
    expect((await bootstrap.query(`SELECT attempts FROM ${schema}.existing`)).rows).toEqual([
      { attempts: 1 }
    ]);
    await expectForcedRls("existing");
    await expectForcedRls("projection");
  });

  it("applies a missing lower version after a higher main version without renumbering", async () => {
    await bootstrap.query(`UPDATE ${schema}.control SET should_fail = false`);
    await writeFile(join(directory, "0294_main_fixture.sql"), "SELECT 1;\n");
    const initial = await migrate();
    expect(initial.applied.map((file) => file.version)).toEqual(["0001", "0294"]);
    await writeFile(
      join(directory, "0284_capture_fixture.sql"),
      `CREATE TABLE ${schema}.late_capture (id integer PRIMARY KEY);\n`
    );
    const upgrade = await migrate();
    expect(upgrade.applied.map((file) => file.version)).toEqual(["0284"]);
    expect(upgrade.skipped.map((file) => file.version)).toEqual(["0001", "0294"]);
    expect(
      (await bootstrap.query("SELECT to_regclass($1)::text AS name", [`${schema}.late_capture`]))
        .rows
    ).toEqual([{ name: `${schema}.late_capture` }]);
    expect((await migrate()).applied).toEqual([]);
  });

  it("also rolls back all sidecar effects if ledger insertion fails after the callback", async () => {
    // First failure creates only the ordinary empty ledger, outside the per-file transaction.
    await expect(migrate()).rejects.toThrow(`Migration backfill ${sidecarName} failed`);
    await bootstrap.query(`
      ALTER TABLE ${schema}.schema_migrations ADD CONSTRAINT fixture_ledger_failure CHECK (false);
      UPDATE ${schema}.control SET should_fail = false;
    `);
    await expect(migrate()).rejects.toThrow("fixture_ledger_failure");
    await assertRolledBack();
  });
});
