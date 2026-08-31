// tests/integration/finance-tables-install.test.ts
// FIN-06a (#1166): proves the REAL external-modules/finance/sql directory installs
// cleanly through the #914 installModule pipeline — DDL, generated FORCE RLS, and
// the migration ledger/journal — before any store code depends on it. Mirrors
// tests/integration/module-install.test.ts's teardown discipline (REVOKE-before-DROP
// CASCADE ordering; see its comment for why CASCADE is required).
import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { getMossDatabaseUrls } from "../../packages/db/src/urls.js";
import { dropModuleRolesAtTeardown, resetEmptyFoundationDatabase } from "./test-database.js";

const urls = getMossDatabaseUrls();
const moduleId = "finance";
const installRole = moduleInstallRoleName(moduleId);
const runtimeRole = moduleRuntimeRoleName(moduleId);
const ownedTables = [
  "app.finance_items",
  "app.finance_accounts",
  "app.finance_transactions",
  "app.finance_balance_snapshots",
  "app.finance_budget_assignments"
];

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
});

afterEach(async () => {
  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  for (const table of ownedTables) {
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  // Same ordering as module-install.test.ts: ensureModuleRoles grants schema/table ACLs to the
  // install role WITH GRANT OPTION (spec D2), and Phase B re-grants onward to the runtime role
  // from that grant option — revoking the install role's own grant needs CASCADE to also strip
  // the runtime role's dependent grant, or Postgres refuses both the revoke and the later DROP ROLE.
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${installRole} CASCADE`);
  await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${installRole}`);
  await client.query(
    `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${installRole} CASCADE`
  );
  await dropModuleRolesAtTeardown([installRole, runtimeRole]);
  await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
  await client.end();
});

describe("finance module table install (FIN-06a #1166)", () => {
  it("installs all eight migrations, FORCE RLS on every table, and re-runs idempotently", async () => {
    const result = await installModule({
      moduleId,
      manifest: { database: { ownedTables } },
      bootstrapConnectionString: urls.bootstrap,
      migrationConnectionString: urls.migration,
      migrationsDirectory: "external-modules/finance/sql"
    });
    expect(result.installed).toHaveLength(8);

    const client = new Client({ connectionString: urls.bootstrap });
    await client.connect();

    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'app' AND table_name = ANY($1::text[])",
      [ownedTables.map((table) => table.replace(/^app\./, ""))]
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      ownedTables.map((table) => table.replace(/^app\./, "")).sort()
    );

    const forceRls = await client.query(
      "SELECT relname FROM pg_class WHERE relname LIKE 'finance_%' AND relforcerowsecurity"
    );
    expect(forceRls.rows.map((row) => row.relname).sort()).toEqual(
      ownedTables.map((table) => table.replace(/^app\./, "")).sort()
    );

    const ledger = await client.query(
      "SELECT version FROM app.module_schema_migrations WHERE module_id = $1",
      [moduleId]
    );
    expect(ledger.rows).toHaveLength(8);

    await client.end();

    // Idempotent re-run: every migration already recorded, so nothing new applies.
    const second = await installModule({
      moduleId,
      manifest: { database: { ownedTables } },
      bootstrapConnectionString: urls.bootstrap,
      migrationConnectionString: urls.migration,
      migrationsDirectory: "external-modules/finance/sql"
    });
    expect(second.installed).toHaveLength(0);
  });
});
