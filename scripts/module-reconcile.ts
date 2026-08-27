// scripts/module-reconcile.ts
// #964 (epic #860): boot-time module reconcile. Runs ONCE per container start, on the
// bootstrap (superuser) connection, BEFORE the API boots. Phase order is spec
// docs/superpowers/specs/2026-07-12-module-distribution-install.md §7 verbatim:
//   0. advisory lock  1. sweep staging temp dirs  2. purges (the ONLY destruction point)
//   3. ensure-present (JARVIS_MODULES_ENSURE)     4. scan disk
//   5. accept staged downloads                    6. DB install per module
//   7. persist drift
// Superuser is REQUIRED and intentional: app.external_modules and app.module_installs
// are FORCE RLS with app-runtime-only policies; the supervisor plane bypasses RLS as
// superuser exactly like scripts/module-install.ts's journalUpsert does today.
// Failure model: per-module failures WARN and continue (a broken module must never
// stop the platform booting); only lock/connection failures exit non-zero.
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import {
  getMossDatabaseUrls,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  resolveMossEnv,
  TargetIdentityMismatchError,
  withClusterDdlLock,
  type WithClusterDdlLockOptions
} from "@moss/db";
import { CORE_VERSION } from "@moss/module-sdk";
import { getAllQueueDefinitions } from "@moss/module-registry";
import {
  downloadAndStageModule,
  getExternalModuleRegistrations,
  ModuleDownloadError,
  parseModulesEnsure,
  resolveModulesDir,
  sweepStagingDirs
} from "@moss/module-registry/node";

import { installModule } from "./module-install.js";

// Matches external/reconcile.ts:12 — the request-time reconciler uses the same copy so
// the admin UI's drift reason is identical whether drift was caught at boot or live.
const DRIFT_DISABLED_REASON = "package changed since it was enabled";

const MODULE_ID_RE = /^[a-z][a-z0-9-]*$/;

export interface ReconcileReport {
  readonly purged: string[];
  readonly ensured: string[];
  readonly accepted: string[];
  readonly installed: string[];
  readonly drifted: string[];
  /** Per-module failures that were logged and skipped (never fatal). */
  readonly warnings: { moduleId: string; phase: string; message: string; code?: string }[];
}

/**
 * Fail-closed guard for table names read from the app.module_installs journal before
 * they are interpolated into DROP TABLE statements. Requires the exact shape the
 * manifest validator enforced at install time (Task 2): `app.<slug>_<rest>` where slug
 * is the module id with hyphens as underscores. Anything else — other schemas, quotes,
 * whitespace, comments, other modules' prefixes — throws.
 */
export function assertQualifiedModuleTable(qualified: string, moduleId: string): void {
  const slug = moduleId.replace(/-/g, "_");
  if (!/^app\.[a-z][a-z0-9_]*$/.test(qualified)) {
    throw new Error(`refusing to drop "${qualified}": not a plain app-schema table name`);
  }
  if (!qualified.startsWith(`app.${slug}_`)) {
    throw new Error(
      `refusing to drop "${qualified}": outside module "${moduleId}" prefix app.${slug}_`
    );
  }
}

/** Pure decision for phase 5 so the hash-match rule is unit-testable. */
export function decideStagedAcceptance(input: {
  readonly stagedPackageHash: string;
  readonly onDiskPackageHash: string | null;
}): { accept: true } | { accept: false; reason: string } {
  if (input.onDiskPackageHash !== null && input.onDiskPackageHash === input.stagedPackageHash) {
    return { accept: true };
  }
  return {
    accept: false,
    reason: `staged package hash ${input.stagedPackageHash} does not match on-disk package hash ${input.onDiskPackageHash ?? "<absent>"}`
  };
}

/**
 * Pure decision for phase 3 (#1057): an exact version pin in `JARVIS_MODULES_ENSURE` must be
 * honored even when some version of the module is already on disk. `onDiskVersions` comes from
 * `preScan.discoveries` (readable manifest, real version); `onDiskUnreadable` comes from
 * `preScan.rejected` (present but no readable manifest — no version to compare, preserve the
 * prior skip-if-present behavior for this leg, out of #1057's scope).
 */
export function decideEnsureAction(
  entry: { readonly id: string; readonly version?: string },
  onDiskVersions: Map<string, string>,
  onDiskUnreadable: Set<string>
): "skip" | "stage" {
  const onDiskVersion = onDiskVersions.get(entry.id);
  if (onDiskVersion !== undefined) {
    return entry.version === undefined || onDiskVersion === entry.version ? "skip" : "stage";
  }
  if (onDiskUnreadable.has(entry.id)) {
    return "skip";
  }
  return "stage";
}

interface ExternalModuleAdminRow {
  readonly id: string;
  readonly status: "enabled" | "disabled";
  readonly package_hash: string | null;
  readonly staged_version: string | null;
  readonly staged_package_hash: string | null;
  readonly purge_requested_at: Date | null;
}

export interface ReconcileModulesOptions {
  readonly modulesDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam (Task 10): injected fetch for the mock registry. */
  readonly fetchFn?: typeof fetch;
}

/**
 * #1468: extends #1383's target-identity guard to this boot-time supervisor entrypoint. An
 * "un-provisioned target" — a database nobody has installed onto yet — is the only state
 * allowed through without a confirmation email, and only when BOTH hold: the connected role is
 * trustworthy (superuser, has `rolbypassrls`, or owns `app.users` — so an unprivileged
 * connection can't forge the exception) AND `app.users` is genuinely empty (`COUNT(*) = 0`, not
 * merely "no row has `is_bootstrap_owner` set" — a populated table with no flagged owner is a
 * broken or tampered state, not a fresh install, and must still refuse).
 */
export async function assertReconcileTargetIdentity(
  client: Client,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const trusted = await isConnectedRoleTrustedForUnprovisionedTarget(client);
  if (trusted && (await isAppUsersGenuinelyEmpty(client))) {
    return;
  }

  const ownerResult = await client.query<{ id: string; email: string }>(
    "SELECT id, email FROM app.users WHERE is_bootstrap_owner = true LIMIT 1"
  );
  const owner = ownerResult.rows[0];
  const confirmedEmail = resolveMossEnv(env, "JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL");

  if (!owner || !confirmedEmail || confirmedEmail !== owner.email) {
    throw new TargetIdentityMismatchError();
  }
}

async function isConnectedRoleTrustedForUnprovisionedTarget(client: Client): Promise<boolean> {
  const roleResult = await client.query<{
    role_name: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user AS role_name, rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`
  );
  const role = roleResult.rows[0];
  if (!role) {
    return false;
  }
  if (role.rolsuper || role.rolbypassrls) {
    return true;
  }

  const ownerResult = await client.query<{ tableowner: string }>(
    `SELECT tableowner
       FROM pg_tables
      WHERE schemaname = 'app' AND tablename = 'users'`
  );
  return ownerResult.rows[0]?.tableowner === role.role_name;
}

async function isAppUsersGenuinelyEmpty(client: Client): Promise<boolean> {
  const schemaCheck = await client.query<{ to_regclass: string | null }>(
    "SELECT to_regclass('app.users')"
  );
  if (schemaCheck.rows[0]?.to_regclass === null) {
    return true;
  }

  const countResult = await client.query<{ count: string }>("SELECT COUNT(*) FROM app.users");
  return countResult.rows[0]?.count === "0";
}

export async function reconcileModules(options: ReconcileModulesOptions): Promise<ReconcileReport> {
  const env = options.env ?? process.env;
  const urls = getMossDatabaseUrls(env);
  // The connection strings above come from `env`; the cluster-DDL lock resolves its maintenance
  // database (JARVIS_CLUSTER_LOCK_DATABASE) from its own options. Handing it anything other than
  // the same `env` splits the lock domain: every participant still acquires a real advisory lock,
  // just in a different database, and advisory-lock tags are scoped by database OID — so the lock
  // succeeds and excludes nobody (#1013).
  const lock: WithClusterDdlLockOptions = { env };
  const report: ReconcileReport = {
    purged: [],
    ensured: [],
    accepted: [],
    installed: [],
    drifted: [],
    warnings: []
  };
  const warn = (moduleId: string, phase: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // #1319: carry the download pipeline's failure code alongside the wording. Boot must keep
    // going either way; this just gives operators (and the boot test) something stable to read
    // instead of an English sentence.
    const code = error instanceof ModuleDownloadError ? error.code : undefined;
    report.warnings.push({ moduleId, phase, message, ...(code ? { code } : {}) });
    console.warn(`[module-reconcile] ${phase} ${moduleId}${code ? ` [${code}]` : ""}: ${message}`);
  };

  const client = new Client({ connectionString: urls.bootstrap });
  await client.connect();
  try {
    await assertReconcileTargetIdentity(client, env);

    // Phase 0 — one lock for the whole run (sql-runner.ts:199 precedent). Session-level
    // (not xact) because destructive phases intentionally run OUTSIDE one big
    // transaction: a purge is a sequence of DDL + fs operations that cannot roll back
    // together, and re-runnability (row deleted LAST) is the recovery model instead.
    await client.query("SELECT pg_advisory_lock(hashtext('jarv1s:module-reconcile'))");

    // Phase 1 — sweep leftover staging temp dirs from crashed downloads (Task 5).
    // sweepStagingDirs is synchronous fs cleanup — not a Promise, so guard with
    // try/catch (not .catch) matching every other synchronous phase-1-style call here.
    try {
      sweepStagingDirs(options.modulesDir);
    } catch (error) {
      warn("*", "sweep", error);
    }

    // Phase 2 — purges: the ONLY place module data is destroyed (spec §9).
    const purgeRows = await client.query<ExternalModuleAdminRow>(
      `SELECT id, status, package_hash, staged_version, staged_package_hash, purge_requested_at
         FROM app.external_modules
        WHERE purge_requested_at IS NOT NULL
        ORDER BY id`
    );
    for (const row of purgeRows.rows) {
      try {
        await purgeModule(client, options.modulesDir, row.id, urls.bootstrap, lock);
        report.purged.push(row.id);
      } catch (error) {
        warn(row.id, "purge", error);
      }
    }

    // Phase 3 — ensure-present (spec §7b): JARVIS_MODULES_ENSURE lists modules that
    // must exist on disk. One-way: removing an id from the list never uninstalls.
    // Already-on-disk ids are skipped here (any staged update still flows via phase 5).
    const ensure = parseModulesEnsure(resolveMossEnv(env, "JARVIS_MODULES_ENSURE") ?? "");
    for (const parseError of ensure.errors) {
      warn("*", "ensure-parse", new Error(parseError));
    }
    const preScan = getExternalModuleRegistrations({
      modulesDir: options.modulesDir,
      coreVersion: CORE_VERSION,
      reservedQueueNames: new Set(getAllQueueDefinitions().map((queue) => queue.name))
    });
    const onDiskVersions = new Map(preScan.discoveries.map((d) => [d.id, d.manifest.version]));
    const onDiskUnreadable = new Set(preScan.rejected.map((r) => r.id));
    for (const entry of ensure.entries) {
      if (decideEnsureAction(entry, onDiskVersions, onDiskUnreadable) === "skip") continue;
      try {
        const staged = await downloadAndStageModule({
          moduleId: entry.id,
          version: entry.version,
          modulesDir: options.modulesDir,
          env,
          fetchFn: options.fetchFn
        });
        // Record the staging exactly like the admin download route does, but with
        // staged_source 'compose-ensure' and no acting user. INSERT-or-UPDATE because
        // a compose-ensured module may have no external_modules row yet; new rows are
        // born disabled (fail-closed) and phase 5 enables them via the hash match.
        await client.query(
          // manifest_hash/package_hash are NOT NULL columns — '' sentinels for a disabled,
          // never-enabled row, matching updateExternalModuleStaging's admin-download
          // convention (repository-external-modules.ts): a disabled row is never active
          // regardless of hash; the real hashes land when reconcile accepts the package.
          `INSERT INTO app.external_modules
             (id, status, manifest_hash, package_hash, staged_version, staged_package_hash, staged_at, staged_by, staged_source, created_at, updated_at)
           VALUES ($1, 'disabled', '', '', $2, $3, now(), NULL, 'compose-ensure', now(), now())
           ON CONFLICT (id) DO UPDATE SET
             staged_version = EXCLUDED.staged_version,
             staged_package_hash = EXCLUDED.staged_package_hash,
             staged_at = now(),
             staged_by = NULL,
             staged_source = 'compose-ensure',
             updated_at = now()`,
          [entry.id, staged.version, staged.packageHash]
        );
        report.ensured.push(entry.id);
      } catch (error) {
        // Includes ModuleDownloadError (registry down, bad hash, …): warn + continue —
        // an unreachable registry must never block boot (spec §7b).
        warn(entry.id, "ensure-download", error);
      }
    }

    // Phase 4 — authoritative post-ensure scan (full validation incl. hashes).
    const scan = getExternalModuleRegistrations({
      modulesDir: options.modulesDir,
      coreVersion: CORE_VERSION,
      reservedQueueNames: new Set(getAllQueueDefinitions().map((queue) => queue.name))
    });
    const discoveriesById = new Map(scan.discoveries.map((d) => [d.id, d]));

    // Phase 5 — accept staged downloads: staged hash must equal the on-disk package
    // hash computed by the validating loader. Match → the staged version becomes the
    // enabled baseline and staged_* fields clear. Mismatch → leave the row staged and
    // warn; the admin UI keeps showing pending-restart with the discrepancy logged.
    const stagedRows = await client.query<ExternalModuleAdminRow>(
      `SELECT id, status, package_hash, staged_version, staged_package_hash, purge_requested_at
         FROM app.external_modules
        WHERE staged_package_hash IS NOT NULL
        ORDER BY id`
    );
    for (const row of stagedRows.rows) {
      const discovery = discoveriesById.get(row.id);
      const decision = decideStagedAcceptance({
        stagedPackageHash: row.staged_package_hash as string,
        onDiskPackageHash: discovery?.packageHash ?? null
      });
      if (!decision.accept) {
        warn(row.id, "accept-staged", new Error(decision.reason));
        continue;
      }
      await client.query(
        `UPDATE app.external_modules
            SET status = 'enabled',
                manifest_hash = $3,
                package_hash = $2,
                disabled_reason = NULL,
                staged_version = NULL,
                staged_package_hash = NULL,
                staged_at = NULL,
                staged_by = NULL,
                staged_source = NULL,
                updated_at = now()
          WHERE id = $1`,
        [row.id, row.staged_package_hash, discovery!.manifestHash]
      );
      report.accepted.push(row.id);
    }

    // Phase 6 — DB install for every discovered module (idempotent: installModule
    // skips already-recorded migrations via app.module_schema_migrations). Failure →
    // journal 'failed' happens inside installModule's own flow where applicable; here
    // we additionally persist last_install_error and pin the module disabled so the
    // API surfaces install-failed instead of booting a half-installed module.
    for (const discovery of scan.discoveries) {
      const sqlDir = join(discovery.dir, "sql");
      try {
        const { installed } = await installModule({
          moduleId: discovery.id,
          manifest: discovery.manifest,
          bootstrapConnectionString: urls.bootstrap,
          migrationConnectionString: urls.migration,
          migrationsDirectory: sqlDir,
          lock
        });
        if (installed.length > 0) report.installed.push(discovery.id);
        // A previous failure heals on successful install: clear the error but do NOT
        // touch status — enable/disable stays an admin (or accept-staged) decision.
        await client.query(
          `UPDATE app.external_modules SET last_install_error = NULL, updated_at = now()
            WHERE id = $1 AND last_install_error IS NOT NULL`,
          [discovery.id]
        );
      } catch (error) {
        warn(discovery.id, "install", error);
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        await client
          .query(
            `UPDATE app.external_modules
                SET last_install_error = $2,
                    status = 'disabled',
                    disabled_reason = 'database install failed',
                    updated_at = now()
              WHERE id = $1`,
            [discovery.id, message]
          )
          .catch((persistError) => warn(discovery.id, "install-error-persist", persistError));
      }
    }

    // Phase 7 — drift persist: enabled row whose baseline hash no longer matches disk
    // → disable with the SAME reason string external/reconcile.ts:12 uses at request
    // time, so boot-caught and live-caught drift read identically in the admin UI.
    const enabledRows = await client.query<ExternalModuleAdminRow>(
      `SELECT id, status, package_hash, staged_version, staged_package_hash, purge_requested_at
         FROM app.external_modules
        WHERE status = 'enabled'
        ORDER BY id`
    );
    for (const row of enabledRows.rows) {
      const discovery = discoveriesById.get(row.id);
      if (discovery && discovery.packageHash === row.package_hash) continue;
      await client.query(
        `UPDATE app.external_modules
            SET status = 'disabled', disabled_reason = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, DRIFT_DISABLED_REASON]
      );
      report.drifted.push(row.id);
    }

    return report;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('jarv1s:module-reconcile'))")
      .catch(() => undefined);
    await client.end();
  }
}

/**
 * Destroys one module completely (spec §9). Order is dependency-safe and re-runnable:
 * the external_modules row (holding purge_requested_at) is deleted LAST, so a crash at
 * any earlier step re-triggers the purge on next boot. Every DROP is idempotent
 * (IF EXISTS) for the same reason.
 */
export async function purgeModule(
  client: Client,
  modulesDir: string,
  moduleId: string,
  bootstrapConnectionString: string,
  options: WithClusterDdlLockOptions = {}
): Promise<void> {
  if (!MODULE_ID_RE.test(moduleId)) {
    throw new Error(`invalid module id "${moduleId}" in purge mark`);
  }

  // 1. Owned tables from the supervisor-written journal — guard each name anyway.
  const journal = await client.query<{ owned_tables: string[] | null }>(
    "SELECT owned_tables FROM app.module_installs WHERE module_id = $1",
    [moduleId]
  );
  for (const table of journal.rows[0]?.owned_tables ?? []) {
    assertQualifiedModuleTable(table, moduleId);
    await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }

  // 2. Platform-table rows keyed by module id (KV, credentials, enablement).
  await client.query("DELETE FROM app.module_kv WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_credentials WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_enablement WHERE module_id = $1", [moduleId]);

  // 3. Migration ledger + install journal.
  await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
  await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);

  // 4. Roles. Roles are cluster-global, so this block — and only this block — runs under the
  // #1632 cluster-DDL lock, on that lock's guarded DDL session (`lockClient`) rather than the
  // reconcile run's connection. The install role re-grants schema USAGE + the RLS-predicate
  // function's EXECUTE onward to the runtime role using its own GRANT OPTION
  // (module-role-broker.ts's ensureModuleRoles) — those two ACL entries are recorded with
  // grantor = install role, not a bootstrap/superuser connection. A superuser-issued
  // `DROP OWNED BY <runtimeRole>` only strips ACL entries THAT connection granted; entries
  // granted by a different grantor survive and block `DROP ROLE` with "some objects depend on
  // it". Revoking the install role's grant option WITH CASCADE removes those downstream grants
  // first. Must run before the runtime role is dropped below. Role names are derived, never
  // read from data.
  const installRole = moduleInstallRoleName(moduleId);
  await withClusterDdlLock(
    bootstrapConnectionString,
    async (lockClient) => {
      await lockClient.query(
        `DO $$ BEGIN
       IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${installRole}') THEN
         EXECUTE format('REVOKE GRANT OPTION FOR USAGE ON SCHEMA app FROM %I CASCADE', '${installRole}');
         EXECUTE format('REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION app.current_actor_user_id() FROM %I CASCADE', '${installRole}');
       END IF;
     END $$`
      );

      // DROP OWNED first releases any remaining grants/objects so DROP ROLE can't fail on
      // dependencies.
      for (const role of [moduleRuntimeRoleName(moduleId), moduleInstallRoleName(moduleId)]) {
        await lockClient.query(
          `DO $$ BEGIN
         IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
           EXECUTE format('DROP OWNED BY %I', '${role}');
           EXECUTE format('DROP ROLE %I', '${role}');
         END IF;
       END $$`
        );
      }
    },
    options
  );

  // 5. Files. MODULE_ID_RE above already proved the id is a bare slug (no traversal).
  await rm(join(modulesDir, moduleId), { recursive: true, force: true });

  // 6. The mark itself — LAST, making every earlier step re-runnable after a crash.
  await client.query("DELETE FROM app.external_modules WHERE id = $1", [moduleId]);
}

// CLI: `tsx scripts/module-reconcile.ts` (wired into container boot after migrate.ts and
// into the root `db:reconcile` script for dev parity). #996/#860: always runs now — the
// JARVIS_ENABLE_EXTERNAL_MODULES flag is gone, external modules are always-on.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modulesDir = resolveModulesDir(process.env);
  reconcileModules({ modulesDir })
    .then((report) => {
      console.log(
        `[module-reconcile] purged=${report.purged.length} ensured=${report.ensured.length} ` +
          `accepted=${report.accepted.length} installed=${report.installed.length} ` +
          `drifted=${report.drifted.length} warnings=${report.warnings.length}`
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error("[module-reconcile] fatal:", error);
      process.exit(1);
    });
}
