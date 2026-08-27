import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { getBuiltInModuleManifests } from "@moss/module-registry";

import { connectionStrings } from "./test-database.js";

const { Client } = pg;

/**
 * #801 Phase A cascade-truth integration test.
 *
 * The registration-time parity assertion (module-registry.test.ts) only checks that every
 * owned table appears in `dataLifecycle.deletion.tables` — it CANNOT verify the declared
 * `strategy: "cascade"` is actually true at the schema level (a declared-but-false cascade is
 * exactly the dangerous case the spec calls out: sports' `app.sports_follows` is the first
 * verified declaration). This test walks the real `pg_constraint` catalog to confirm each
 * declared cascade table has a genuine `ON DELETE CASCADE` foreign-key chain to `app.users`.
 */

let client: pg.Client;

beforeAll(async () => {
  client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

interface ForeignKeyEdge {
  readonly refSchema: string;
  readonly refTable: string;
  readonly onDeleteCascade: boolean;
}

async function outgoingForeignKeys(
  pgClient: pg.Client,
  schema: string,
  table: string
): Promise<readonly ForeignKeyEdge[]> {
  const result = await pgClient.query<{
    ref_schema: string;
    ref_table: string;
    confdeltype: string;
  }>(
    `SELECT ns2.nspname AS ref_schema, t2.relname AS ref_table, c.confdeltype
     FROM pg_constraint c
     JOIN pg_class t1 ON t1.oid = c.conrelid
     JOIN pg_namespace ns1 ON ns1.oid = t1.relnamespace
     JOIN pg_class t2 ON t2.oid = c.confrelid
     JOIN pg_namespace ns2 ON ns2.oid = t2.relnamespace
     WHERE ns1.nspname = $1 AND t1.relname = $2 AND c.contype = 'f'`,
    [schema, table]
  );
  return result.rows.map((row) => ({
    refSchema: row.ref_schema,
    refTable: row.ref_table,
    onDeleteCascade: row.confdeltype === "c"
  }));
}

/**
 * True iff `schema.table` has a chain of `ON DELETE CASCADE` foreign keys that terminates at
 * `app.users`. A non-cascade edge (RESTRICT/SET NULL/SET DEFAULT/NO ACTION) is not followed —
 * declaring cascade on a table whose only path to app.users is non-cascading must fail.
 */
async function hasCascadeChainToUsers(
  pgClient: pg.Client,
  qualifiedTable: string,
  visited: Set<string> = new Set()
): Promise<boolean> {
  if (visited.has(qualifiedTable)) return false;
  visited.add(qualifiedTable);

  const [schema, table] = qualifiedTable.split(".");
  if (!schema || !table) {
    throw new Error(`Expected "schema.table", got "${qualifiedTable}"`);
  }

  const edges = await outgoingForeignKeys(pgClient, schema, table);
  for (const edge of edges) {
    if (!edge.onDeleteCascade) continue;
    if (edge.refSchema === "app" && edge.refTable === "users") return true;
    const nextQualified = `${edge.refSchema}.${edge.refTable}`;
    if (await hasCascadeChainToUsers(pgClient, nextQualified, visited)) return true;
  }
  return false;
}

describe("dataLifecycle cascade-truth (#801 Phase A)", () => {
  it("every declared cascade table across built-in modules really cascades to app.users", async () => {
    const manifests = getBuiltInModuleManifests();
    const cascadeTables = manifests.flatMap((manifest) =>
      manifest.dataLifecycle?.deletion.strategy === "cascade"
        ? manifest.dataLifecycle.deletion.tables.map((entry) => ({
            moduleId: manifest.id,
            table: entry.table
          }))
        : []
    );

    // Sanity: this test is only meaningful if it actually exercises rows. Phase A migrated
    // wellness (4 tables) + sports (1 table) — fail loudly if that ever regresses to zero.
    expect(cascadeTables.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const { moduleId, table } of cascadeTables) {
      const cascades = await hasCascadeChainToUsers(client, table);
      if (!cascades) {
        failures.push(
          `module "${moduleId}": "${table}" has no ON DELETE CASCADE chain to app.users`
        );
      }
    }
    expect(failures).toEqual([]);

    // Pin the concrete Phase A table set so a future refactor can't silently shrink coverage.
    const tableNames = cascadeTables.map((entry) => entry.table).sort();
    expect(tableNames).toEqual(
      [
        "app.wellness_checkins",
        "app.medications",
        "app.medication_logs",
        "app.wellness_therapy_notes",
        "app.sports_follows",
        // #1572 custom sports news sources by team and league.
        "app.sports_custom_sources",
        "app.sports_source_assignments",
        "app.sports_espn_source_assignments",
        "app.sports_policy_verdicts",
        "app.sports_headline_prefs",
        "app.news_prefs",
        // #953 News Slice 1 personalization tables — all owner-keyed to app.users cascade.
        "app.news_custom_sources",
        "app.news_custom_topics",
        "app.news_source_exclusions",
        "app.news_compilation_snapshots",
        // #958 News Slice 2 owner-scoped refresh coordination and verdict cache.
        "app.news_refresh_state",
        "app.news_policy_verdicts",
        // #2005 News publisher credentials — cascade on the user and on the source.
        "app.news_source_credentials"
      ].sort()
    );
  });

  describe("RED: a declared-but-false cascade is caught", () => {
    const restrictTable = "cascade_truth_fixture_restrict";
    const cascadeTable = "cascade_truth_fixture_cascade";

    beforeAll(async () => {
      await client.query(
        `CREATE TABLE app.${cascadeTable} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE
         )`
      );
      await client.query(
        `CREATE TABLE app.${restrictTable} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT
         )`
      );
    });

    afterAll(async () => {
      await client.query(`DROP TABLE IF EXISTS app.${restrictTable}`);
      await client.query(`DROP TABLE IF EXISTS app.${cascadeTable}`);
    });

    it("GREEN: a genuinely cascading fixture table passes", async () => {
      await expect(hasCascadeChainToUsers(client, `app.${cascadeTable}`)).resolves.toBe(true);
    });

    it("RED: a fixture table whose FK is ON DELETE RESTRICT fails the cascade-truth check", async () => {
      await expect(hasCascadeChainToUsers(client, `app.${restrictTable}`)).resolves.toBe(false);
    });
  });
});
