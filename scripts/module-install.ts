// Slice 2 (#914): 4-phase module install entrypoint.
//   Phase A (bootstrap/superuser conn): ensure roles, journal 'installing'.
//   Phase B (installer conn, ONE transaction): apply module DDL + generated RLS/grants.
//   Phase C (migration-owner conn): record ledger rows, flip journal to 'installed'.
//   Phase D (bootstrap/superuser conn): disable installer login, always (finally).
// Recovery model: if the process dies between B and C, a re-run's Phase A finds the journal row
// already 'installing' and unconditionally resets the install role to NOLOGIN (module-role-broker's
// own crash-recovery guard, independent of this file's try/finally). Phase B is re-entered and
// re-applies (idempotent DDL is a module-author responsibility per the wire contract's CREATE
// TABLE/INDEX-only allowlist), and Phase C's ledger insert only runs for migrations
// getAppliedModuleMigrations hasn't already recorded, so a retry never double-applies.
import { Client } from "pg";

import {
  assertQualifiedTableName,
  disableInstallerLogin,
  enableInstallerLogin,
  ensureModuleRoles,
  generateModuleTableRlsSql,
  getAppliedModuleMigrations,
  loadModuleMigrationFiles,
  recordModuleMigrations,
  type WithClusterDdlLockOptions
} from "@moss/db";

export interface ModuleInstallOptions {
  readonly moduleId: string;
  // Structural on purpose (#964): installModule only reads database.ownedTables, and
  // callers hold either the branded MossModuleManifest (dev CLI) or the loader's
  // JsonMossModuleManifest (boot reconcile). Both satisfy this shape.
  readonly manifest: { readonly database?: { readonly ownedTables?: readonly string[] } };
  readonly bootstrapConnectionString: string;
  readonly migrationConnectionString: string;
  readonly migrationsDirectory: string;
  /**
   * Cluster-DDL lock options for phases A and D (#1013). Every role-touching call below writes the
   * cluster-global `pg_authid`, so all three must land in the SAME lock domain. The lock derives
   * its maintenance database from `options.env`; leaving this undefined makes it fall back to
   * ambient `process.env` while the connection strings came from a caller-injected env — a
   * lock-domain split that acquires a real lock in the wrong database and excludes nobody.
   */
  readonly lock?: WithClusterDdlLockOptions;
}

export async function installModule(
  options: ModuleInstallOptions
): Promise<{ installed: string[] }> {
  const { moduleId, manifest, bootstrapConnectionString, migrationConnectionString } = options;
  const ownedTables = manifest.database?.ownedTables ?? [];
  const lock = options.lock ?? {};

  // Phase A
  const { runtimeRole, installRole } = await ensureModuleRoles(
    bootstrapConnectionString,
    moduleId,
    lock
  );
  await journalUpsert(bootstrapConnectionString, {
    moduleId,
    status: "installing",
    tablePrefix: moduleId.replace(/-/g, "_"),
    ownedTables,
    runtimeRole,
    installRole
  });
  const password = await enableInstallerLogin(bootstrapConnectionString, moduleId, lock);

  let installed: string[];
  try {
    // Phase B
    const alreadyApplied = await getAppliedModuleMigrations(migrationConnectionString, moduleId);
    const files = (await loadModuleMigrationFiles(options.migrationsDirectory)).filter(
      (file) => !alreadyApplied.has(file.version)
    );

    const installerConnectionString = withCredentials(
      bootstrapConnectionString,
      installRole,
      password
    );
    const installerClient = new Client({ connectionString: installerConnectionString });
    await installerClient.connect();
    try {
      await installerClient.query("BEGIN");
      // Existing module tables are FORCE-RLS'd after their first install. The installer owns
      // them but has no actor-scoped runtime policy, so an UPDATE migration otherwise succeeds
      // while touching zero rows. Relax FORCE only inside this transaction; rollback restores it
      // on failure, and the generated RLS statements below restore it before commit.
      for (const table of ownedTables) {
        assertQualifiedTableName(table);
        await installerClient.query(`ALTER TABLE IF EXISTS ${table} NO FORCE ROW LEVEL SECURITY`);
      }
      for (const file of files) {
        await installerClient.query(file.sql);
      }
      for (const statement of generateModuleTableRlsSql(moduleId, ownedTables)) {
        await installerClient.query(statement);
      }
      await installerClient.query("COMMIT");
    } catch (error) {
      await installerClient.query("ROLLBACK");
      throw error;
    } finally {
      await installerClient.end();
    }

    // Phase C
    if (files.length > 0) {
      await recordModuleMigrations(migrationConnectionString, moduleId, files);
    }
    await journalUpsert(bootstrapConnectionString, {
      moduleId,
      status: "installed",
      tablePrefix: moduleId.replace(/-/g, "_"),
      ownedTables,
      runtimeRole,
      installRole,
      installedAt: new Date()
    });
    installed = files.map((file) => file.name);
  } finally {
    // Phase D — always, success or failure.
    await disableInstallerLogin(bootstrapConnectionString, moduleId, lock);
  }

  return { installed };
}

function withCredentials(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

interface JournalRow {
  readonly moduleId: string;
  readonly status: "installing" | "installed" | "failed";
  readonly tablePrefix: string;
  readonly ownedTables: readonly string[];
  readonly runtimeRole: string;
  readonly installRole: string;
  readonly installedAt?: Date;
}

async function journalUpsert(connectionString: string, row: JournalRow): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.module_installs
         (module_id, status, table_prefix, owned_tables, runtime_role, install_role, installed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (module_id) DO UPDATE SET
         status = EXCLUDED.status,
         owned_tables = EXCLUDED.owned_tables,
         installed_at = COALESCE(EXCLUDED.installed_at, app.module_installs.installed_at),
         updated_at = now()`,
      [
        row.moduleId,
        row.status,
        row.tablePrefix,
        row.ownedTables,
        row.runtimeRole,
        row.installRole,
        row.installedAt ?? null
      ]
    );
  } finally {
    await client.end();
  }
}
