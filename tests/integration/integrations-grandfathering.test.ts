import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql, type Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { effectiveEnabledTools } from "@moss/integrations";
import type { IntegrationToolDescriptor } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationSql = readFileSync(
  join(root, "packages/integrations/sql/0209_integration_group_derivation_grandfather.sql"),
  "utf8"
);

const OWNER_ID = "00000000-0000-4000-8000-000000000001";

function toolNames(count: number, group = ""): { name: string; group: string }[] {
  return Array.from({ length: count }, (_, i) => ({ name: `tool_${i}`, group }));
}

/**
 * The migration runner already applied 0209 once, at reset time, before any of these rows
 * existed — it hash-checks applied files and will not run 0209 again. So this test seeds the
 * rows the migration is meant to grandfather directly (bypassing RLS via the migration/superuser
 * channel, the same one the runner itself uses) and then executes the migration's own SQL text
 * against them, to prove what that SQL does rather than re-triggering the runner.
 */
describe("#2175 Task 5 — 0209 grandfathering migration", () => {
  // Seeding uses the bootstrap (superuser) channel — same as seedProbeData — because arranging
  // rows for an owner-scoped RLS table needs to bypass RLS. The migration itself is executed
  // through the migration connection so this test proves what the real migration role can do.
  let seedClient: pg.Client;
  let migrationClient: pg.Client;
  let appDb: Kysely<MossDatabase>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    seedClient = new Client({ connectionString: connectionStrings.bootstrap });
    await seedClient.connect();
    migrationClient = new Client({ connectionString: connectionStrings.migration });
    await migrationClient.connect();
    appDb = createDatabase({ connectionString: connectionStrings.app });
  });

  afterAll(async () => {
    await seedClient.end();
    await migrationClient.end();
    await appDb?.destroy();
  });

  async function insertConnection(params: {
    name: string;
    discoveredTools: { name: string; group: string }[];
    mutedTools: string[];
    enabledTools: string[];
  }): Promise<string> {
    const result = await seedClient.query<{ id: string }>(
      `INSERT INTO app.integration_connections
         (owner_user_id, name, kind, url, discovered_tools, muted_tools, enabled_tools)
       VALUES ($1, $2, 'mcp', 'https://mcp.example.com', $3::jsonb, $4, $5)
       RETURNING id`,
      [
        OWNER_ID,
        params.name,
        JSON.stringify(params.discoveredTools),
        params.mutedTools,
        params.enabledTools
      ]
    );
    return result.rows[0]!.id;
  }

  it("grandfathers only the exact eligible rows and leaves the rest untouched", async () => {
    const eligibleId = await insertConnection({
      name: "grandfather-eligible",
      discoveredTools: toolNames(35),
      mutedTools: ["tool_1"],
      enabledTools: []
    });
    const underThresholdId = await insertConnection({
      name: "grandfather-under-threshold",
      discoveredTools: toolNames(10),
      mutedTools: [],
      enabledTools: []
    });
    const realGroupId = await insertConnection({
      name: "grandfather-real-group",
      discoveredTools: [...toolNames(34), { name: "tool_grouped", group: "Media" }],
      mutedTools: [],
      enabledTools: []
    });
    const alreadyExplicitId = await insertConnection({
      name: "grandfather-already-explicit",
      discoveredTools: toolNames(35),
      mutedTools: [],
      enabledTools: ["tool_0"]
    });

    await migrationClient.query(migrationSql);

    const { rows } = await seedClient.query<{ id: string; enabled_tools: string[] }>(
      `SELECT id, enabled_tools FROM app.integration_connections WHERE id = ANY($1) ORDER BY id`,
      [[eligibleId, underThresholdId, realGroupId, alreadyExplicitId]]
    );
    const byId = new Map(rows.map((r) => [r.id, r.enabled_tools]));

    const expectedEligible = toolNames(35)
      .map((t) => t.name)
      .filter((name) => name !== "tool_1")
      .sort();
    expect([...byId.get(eligibleId)!].sort()).toEqual(expectedEligible);

    expect(byId.get(underThresholdId)).toEqual([]);
    expect(byId.get(realGroupId)).toEqual([]);
    expect(byId.get(alreadyExplicitId)).toEqual(["tool_0"]);
  });

  // QA round 1, #2175 comment 5515241034, blocking finding 1: array_agg over an empty result
  // set is NULL, not '{}', so an eligible connection with every tool muted wrote NULL into a
  // NOT NULL column and rolled back the whole migration.
  it("grandfathers an all-muted eligible connection to an empty list instead of failing", async () => {
    const allTools = toolNames(35);
    const allMutedId = await insertConnection({
      name: "grandfather-all-muted",
      discoveredTools: allTools,
      mutedTools: allTools.map((t) => t.name),
      enabledTools: []
    });

    await expect(migrationClient.query(migrationSql)).resolves.toBeDefined();

    const { rows } = await seedClient.query<{ enabled_tools: string[] }>(
      `SELECT enabled_tools FROM app.integration_connections WHERE id = $1`,
      [allMutedId]
    );
    expect(rows[0]!.enabled_tools).toEqual([]);
  });

  it("leaves row-level security enabled and forced after the migration runs", async () => {
    await migrationClient.query(migrationSql);

    const { rows } = await seedClient.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE oid = 'app.integration_connections'::regclass`
    );

    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it("leaves exactly the two original policies on the table after the migration runs", async () => {
    await migrationClient.query(migrationSql);

    const { rows } = await seedClient.query<{ policyname: string }>(
      `SELECT policyname
       FROM pg_policies
       WHERE schemaname = 'app' AND tablename = 'integration_connections'
       ORDER BY policyname`
    );

    expect(rows.map((r) => r.policyname)).toEqual([
      "integration_connections_owner",
      "integration_connections_worker_read"
    ]);
  });

  it("keeps the same effective enabled tools across the migration, and leaves a later-discovered tool off", async () => {
    const discoveredTools = toolNames(35);
    const eligibleId = await insertConnection({
      name: "grandfather-upgrade-path",
      discoveredTools,
      mutedTools: ["tool_1"],
      enabledTools: []
    });

    function toDescriptors(names: { name: string; group: string }[]): IntegrationToolDescriptor[] {
      return names.map((t) => ({
        name: t.name,
        description: "",
        group: t.group,
        inputSchema: null
      }));
    }

    // Before the migration, an empty enabled_tools list under the old rule meant
    // "everything not muted is live" -- that behavior is what the migration must preserve,
    // not what today's stricter effectiveEnabledTools would compute against an empty list.
    const beforeMigration = discoveredTools.map((t) => t.name).filter((name) => name !== "tool_1");

    await migrationClient.query(migrationSql);

    const { rows } = await seedClient.query<{
      enabled_tools: string[];
      muted_tools: string[];
    }>(`SELECT enabled_tools, muted_tools FROM app.integration_connections WHERE id = $1`, [
      eligibleId
    ]);
    const row = rows[0]!;

    const afterMigration = effectiveEnabledTools(toDescriptors(discoveredTools), {
      enabledGroups: [],
      enabledTools: row.enabled_tools,
      mutedTools: row.muted_tools
    }).map((t) => t.name);

    expect(afterMigration.sort()).toEqual(beforeMigration.sort());

    // A later refresh discovers a new tool. saveDiscovery never touches enabled_tools, so the
    // row's enabled_tools is unchanged; the new tool must stay off until the user opts in.
    const refreshedTools = [...discoveredTools, { name: "tool_new_from_refresh", group: "" }];
    const afterRefresh = effectiveEnabledTools(toDescriptors(refreshedTools), {
      enabledGroups: [],
      enabledTools: row.enabled_tools,
      mutedTools: row.muted_tools
    }).map((t) => t.name);

    expect(row.enabled_tools).not.toContain("tool_new_from_refresh");
    expect(afterRefresh).not.toContain("tool_new_from_refresh");
  });

  it("still hides another user's connections from jarvis_app_runtime after the migration runs", async () => {
    await insertConnection({
      name: "grandfather-cross-user-probe",
      discoveredTools: toolNames(35),
      mutedTools: [],
      enabledTools: []
    });
    await migrationClient.query(migrationSql);

    const dataContext = new DataContextRunner(appDb);
    const rows = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "integrations-grandfathering:cross-user" },
      async (scopedDb) => {
        const result = await sql<{ id: string }>`
          SELECT id FROM app.integration_connections
        `.execute(scopedDb.db);
        return result.rows;
      }
    );

    expect(rows).toEqual([]);
  });
});
