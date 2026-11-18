import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { isPinnableHost } from "@moss/datasets";
import { getMossDatabaseUrls } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";

const { Client } = pg;

const runtimeRoles = [
  "jarvis_app_runtime",
  "jarvis_auth_runtime",
  "jarvis_migration_owner",
  "jarvis_worker_runtime"
] as const;

// Auth-secret tables: must have FORCE RLS, and jarvis_app_runtime must not be able
// to SELECT directly (grant was revoked — any row access goes through the auth role).
const authSecretTables = [
  "auth_accounts",
  "auth_sessions",
  "auth_verifications",
  "better_auth_sessions"
] as const;

// Auth owner table: must have RLS ENABLED (not forced — owner bypass needed for SECURITY DEFINER
// functions); jarvis_app_runtime retains SELECT (all rows, for admin routes + membership checks).
const authOwnerTable = ["users"] as const;

const protectedTables = [
  "ai_assistant_action_requests",
  "ai_configured_models",
  "ai_provider_configs",
  "briefing_definitions",
  "briefing_runs",
  "calendar_events",
  "chat_messages",
  "chat_threads",
  "connector_accounts",
  "email_messages",
  "module_credentials",
  "notification_reads",
  "notifications",
  "task_activity",
  "tasks"
] as const;

const protectedTablesWithWorkerDelete = new Set<string>([
  // Google sync worker reconciles stale/cancelled cached events. Owner-scoped DELETE policy still
  // applies; app runtime stays unable to DELETE calendar events.
  "calendar_events",
  // Migration 0175 (Task 2b, #1283): ctx.notify's keyed-upsert "return to unread" clears the read
  // row on a re-fire from the worker/queue lane. notification_reads_delete_worker is owner-scoped
  // AND re-checks the parent notification's visibility via an EXISTS subquery against
  // app.notifications (itself FORCE RLS, no BYPASSRLS role) -- a worker can only delete a read row
  // it could also see.
  "notification_reads"
]);

const protectedTablesWithAppDelete = new Set<string>([
  // #982/#869 D6: CLI model reconciliation hard-deletes concrete rows only. Migration 0163 keeps
  // FORCE RLS, requires an admin actor, and protects the `default` sentinel in policy + code.
  "ai_configured_models",
  // Migration 0175 (Task 2b, #1283): same keyed-upsert return-to-unread capability, app-runtime
  // side. notification_reads_delete mirrors the worker policy above verbatim -- owner-scoped plus
  // the visible-parent EXISTS guard.
  "notification_reads"
]);

// Transient tables: owner-only RLS required, but runtime DELETE is intentional
// (rows are cleaned up as part of normal operation, e.g. after OAuth completes).
const transientTables = ["connector_oauth_pending"] as const;

// Instance-admin tables: hold no per-user owner data but ARE RLS ENABLED+FORCED
// (migration 0059) so app_runtime cannot read/write them outside an admin-scoped
// policy. They don't fit `protectedTables` — instance_settings retains an RLS-gated
// app_runtime write grant (admin-only by policy), and admin_audit_events is
// append-only — so their privilege shapes are checked separately
// (admin_audit_events via readAdminAuditPrivileges; instance_settings writes are
// admin-gated by policy). Here we assert only that RLS is enabled and forced.
const adminRlsTables = ["admin_audit_events", "instance_settings"] as const;

// Tables in the app schema that are intentionally exempt from FORCE RLS.
// This list must remain small. Every entry requires a documented reason.
// Adding a new owner-data table here without a strong architectural justification
// is a security defect — the dynamic coverage check below will catch omissions.
const forceRlsExemptions = new Map<string, string>([
  // Migration runner bookkeeping (applied filename + hash + timestamp). Instance
  // infra written only by jarvis_migration_owner; holds no per-user rows.
  ["schema_migrations", "migration-runner bookkeeping: instance infra, no per-user data"],
  // Per-module migration-runner bookkeeping (#914). Instance infra written only by the
  // per-module installer role; holds no per-user data — same posture as schema_migrations.
  [
    "module_schema_migrations",
    "per-module migration-runner bookkeeping (#914): instance infra, no per-user data — same " +
      "posture as schema_migrations"
  ],
  // users has ENABLE (not FORCE) so jarvis_migration_owner can bypass for SECURITY DEFINER
  // auth functions. Checked explicitly in the authOwnerTable block above.
  ["users", "ENABLE-only: SECURITY DEFINER auth functions need owner bypass; checked separately"],
  // The desktop notifier signs in with a device token before any actor is known, so the
  // SECURITY DEFINER lookup function must read this table as its owner. Runtime roles stay
  // bound by the owner-only policy; only the token hash is stored.
  [
    "desktop_notifier_devices",
    "ENABLE-only: SECURITY DEFINER token lookup needs owner bypass; runtime roles stay under the owner policy"
  ]
]);

export interface AuditReleaseHardeningOptions {
  readonly bootstrapConnectionString?: string;
}

export interface RuntimeRoleAudit {
  readonly bypassRls: boolean;
  readonly canCreateDb: boolean;
  readonly canCreateRole: boolean;
  readonly isSuperuser: boolean;
  readonly roleName: string;
}

export interface AuthSecretTableAudit {
  readonly appCanSelect: boolean;
  readonly forceRls: boolean;
  readonly rlsEnabled: boolean;
  readonly tableName: string;
}

export interface ProtectedTableAudit {
  readonly appCanDelete: boolean;
  readonly forceRls: boolean;
  readonly rlsEnabled: boolean;
  readonly tableName: string;
  readonly workerCanDelete: boolean;
}

export interface AdminAuditPrivileges {
  readonly appCanDelete: boolean;
  readonly appCanInsert: boolean;
  readonly appCanSelect: boolean;
  readonly appCanUpdate: boolean;
  readonly workerCanDelete: boolean;
  readonly workerCanInsert: boolean;
  readonly workerCanSelect: boolean;
  readonly workerCanUpdate: boolean;
}

/** RLS state of a table as read from pg_class. */
export interface AppSchemaTableRlsState {
  readonly forceRls: boolean;
  readonly rlsEnabled: boolean;
  readonly tableName: string;
}

/**
 * externalSources host-list sweep (docs/superpowers/specs/2026-07-04-module-dataset-connector-
 * sdk.md, Verification). Registration-time `assertModuleRegistryConsistency` already rejects an
 * invalid `fetchHost` before the composition root can boot, so every module reachable here has
 * already passed — this is a defense-in-depth re-check using the same `isPinnableHost` predicate,
 * so drift between the two call sites (or a future bypass of the registration gate) surfaces here
 * too, not just at boot.
 */
export interface ExternalSourceHostAudit {
  readonly moduleId: string;
  readonly sourceId: string;
  readonly fetchHosts: readonly string[];
  readonly imageHosts: readonly string[];
  readonly valid: boolean;
}

function auditExternalSourceHosts(): readonly ExternalSourceHostAudit[] {
  const audits: ExternalSourceHostAudit[] = [];
  for (const manifest of getBuiltInModuleManifests()) {
    for (const source of manifest.externalSources ?? []) {
      const hosts = [...source.fetchHosts, ...(source.imageHosts ?? [])];
      audits.push({
        moduleId: manifest.id,
        sourceId: source.id,
        fetchHosts: source.fetchHosts,
        imageHosts: source.imageHosts ?? [],
        valid: hosts.length > 0 && hosts.every((host) => isPinnableHost(host))
      });
    }
  }
  return audits;
}

export interface ReleaseHardeningAuditReport {
  readonly adminAuditPrivileges: AdminAuditPrivileges;
  readonly appSchemaCoverage: readonly AppSchemaTableRlsState[];
  readonly authSecretTables: readonly AuthSecretTableAudit[];
  readonly authOwnerTable: readonly AuthSecretTableAudit[];
  readonly externalSources: readonly ExternalSourceHostAudit[];
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly protectedTables: readonly ProtectedTableAudit[];
  readonly transientTables: readonly ProtectedTableAudit[];
  readonly roles: readonly RuntimeRoleAudit[];
}

export async function auditReleaseHardening(
  options: AuditReleaseHardeningOptions = {}
): Promise<ReleaseHardeningAuditReport> {
  const client = new Client({
    connectionString: options.bootstrapConnectionString ?? getMossDatabaseUrls().bootstrap
  });

  await client.connect();
  try {
    const roles = await readRuntimeRoles(client);
    const tableAudits = await readTableAudits(client, [...protectedTables]);
    const transientTableAudits = await readTableAudits(client, [...transientTables]);
    const authSecretTableAudits = await readAuthSecretAudits(client, [...authSecretTables]);
    const authOwnerTableAudits = await readAuthSecretAudits(client, [...authOwnerTable]);
    const adminAuditPrivileges = await readAdminAuditPrivileges(client);
    const appSchemaCoverage = await readAllAppSchemaTables(client);
    const externalSources = auditExternalSourceHosts();
    const failures = [
      ...collectFailures(
        roles,
        tableAudits,
        transientTableAudits,
        authSecretTableAudits,
        authOwnerTableAudits,
        adminAuditPrivileges,
        appSchemaCoverage
      ),
      ...externalSources
        .filter((source) => !source.valid)
        .map(
          (source) =>
            `external source "${source.sourceId}" (module "${source.moduleId}") declares an invalid host`
        )
    ];

    return {
      adminAuditPrivileges,
      appSchemaCoverage,
      authSecretTables: authSecretTableAudits,
      authOwnerTable: authOwnerTableAudits,
      externalSources,
      failures,
      passed: failures.length === 0,
      protectedTables: tableAudits,
      transientTables: transientTableAudits,
      roles
    };
  } finally {
    await client.end();
  }
}

async function readRuntimeRoles(client: pg.Client): Promise<readonly RuntimeRoleAudit[]> {
  const result = await client.query<{
    bypass_rls: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    is_superuser: boolean;
    role_name: string;
  }>(
    `
      SELECT
        rolname AS role_name,
        rolsuper AS is_superuser,
        rolcreatedb AS can_create_db,
        rolcreaterole AS can_create_role,
        rolbypassrls AS bypass_rls
      FROM pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname
    `,
    [[...runtimeRoles]]
  );

  return result.rows.map((row) => ({
    bypassRls: row.bypass_rls,
    canCreateDb: row.can_create_db,
    canCreateRole: row.can_create_role,
    isSuperuser: row.is_superuser,
    roleName: row.role_name
  }));
}

async function readTableAudits(
  client: pg.Client,
  tableNames: readonly string[]
): Promise<readonly ProtectedTableAudit[]> {
  const result = await client.query<{
    app_can_delete: boolean;
    force_rls: boolean;
    rls_enabled: boolean;
    table_name: string;
    worker_can_delete: boolean;
  }>(
    `
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS force_rls,
        has_table_privilege('jarvis_app_runtime', c.oid, 'DELETE') AS app_can_delete,
        has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE') AS worker_can_delete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `,
    [[...tableNames]]
  );

  return result.rows.map((row) => ({
    appCanDelete: row.app_can_delete,
    forceRls: row.force_rls,
    rlsEnabled: row.rls_enabled,
    tableName: row.table_name,
    workerCanDelete: row.worker_can_delete
  }));
}

async function readAuthSecretAudits(
  client: pg.Client,
  tableNames: readonly string[]
): Promise<readonly AuthSecretTableAudit[]> {
  const result = await client.query<{
    app_can_select: boolean;
    force_rls: boolean;
    rls_enabled: boolean;
    table_name: string;
  }>(
    `
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS force_rls,
        has_table_privilege('jarvis_app_runtime', c.oid, 'SELECT') AS app_can_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `,
    [[...tableNames]]
  );

  return result.rows.map((row) => ({
    appCanSelect: row.app_can_select,
    forceRls: row.force_rls,
    rlsEnabled: row.rls_enabled,
    tableName: row.table_name
  }));
}

/**
 * Reads RLS state for every base table in the `app` schema from pg_class.
 * This is the source of truth for the dynamic coverage check: every table
 * returned here must either be covered by the static checks above (authSecretTables,
 * authOwnerTable, protectedTables, transientTables) or appear in forceRlsExemptions.
 */
async function readAllAppSchemaTables(
  client: pg.Client
): Promise<readonly AppSchemaTableRlsState[]> {
  const result = await client.query<{
    force_rls: boolean;
    rls_enabled: boolean;
    table_name: string;
  }>(
    `
      SELECT
        c.relname AS table_name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS force_rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relkind = 'r'
      ORDER BY c.relname
    `
  );

  return result.rows.map((row) => ({
    forceRls: row.force_rls,
    rlsEnabled: row.rls_enabled,
    tableName: row.table_name
  }));
}

async function readAdminAuditPrivileges(client: pg.Client): Promise<AdminAuditPrivileges> {
  const result = await client.query<AdminAuditPrivileges>(
    `
      SELECT
        has_table_privilege('jarvis_app_runtime', 'app.admin_audit_events', 'SELECT') AS "appCanSelect",
        has_table_privilege('jarvis_app_runtime', 'app.admin_audit_events', 'INSERT') AS "appCanInsert",
        has_table_privilege('jarvis_app_runtime', 'app.admin_audit_events', 'UPDATE') AS "appCanUpdate",
        has_table_privilege('jarvis_app_runtime', 'app.admin_audit_events', 'DELETE') AS "appCanDelete",
        has_table_privilege('jarvis_worker_runtime', 'app.admin_audit_events', 'SELECT') AS "workerCanSelect",
        has_table_privilege('jarvis_worker_runtime', 'app.admin_audit_events', 'INSERT') AS "workerCanInsert",
        has_table_privilege('jarvis_worker_runtime', 'app.admin_audit_events', 'UPDATE') AS "workerCanUpdate",
        has_table_privilege('jarvis_worker_runtime', 'app.admin_audit_events', 'DELETE') AS "workerCanDelete"
    `
  );

  const privileges = result.rows[0];
  if (!privileges) {
    throw new Error("Unable to read admin audit privileges");
  }

  return privileges;
}

function collectFailures(
  roles: readonly RuntimeRoleAudit[],
  tableAudits: readonly ProtectedTableAudit[],
  transientTableAudits: readonly ProtectedTableAudit[],
  authSecretTableAudits: readonly AuthSecretTableAudit[],
  authOwnerTableAudits: readonly AuthSecretTableAudit[],
  adminAuditPrivileges: AdminAuditPrivileges,
  appSchemaCoverage: readonly AppSchemaTableRlsState[]
): readonly string[] {
  const failures: string[] = [];
  const presentRoleNames = new Set(roles.map((role) => role.roleName));
  const presentTableNames = new Set(tableAudits.map((table) => table.tableName));
  const presentTransientNames = new Set(transientTableAudits.map((t) => t.tableName));
  const presentAuthSecretNames = new Set(authSecretTableAudits.map((t) => t.tableName));
  const presentAuthOwnerNames = new Set(authOwnerTableAudits.map((t) => t.tableName));

  for (const role of runtimeRoles) {
    if (!presentRoleNames.has(role)) {
      failures.push(`missing role: ${role}`);
    }
  }
  for (const role of roles) {
    if (role.isSuperuser) failures.push(`${role.roleName} is superuser`);
    if (role.canCreateDb) failures.push(`${role.roleName} can create databases`);
    if (role.canCreateRole) failures.push(`${role.roleName} can create roles`);
    if (role.bypassRls) failures.push(`${role.roleName} can bypass RLS`);
  }

  for (const table of protectedTables) {
    if (!presentTableNames.has(table)) {
      failures.push(`missing protected table: ${table}`);
    }
  }
  for (const table of tableAudits) {
    if (!table.rlsEnabled) failures.push(`app.${table.tableName} does not enable RLS`);
    if (!table.forceRls) failures.push(`app.${table.tableName} does not force RLS`);
    if (table.appCanDelete && !protectedTablesWithAppDelete.has(table.tableName)) {
      failures.push(`jarvis_app_runtime can DELETE app.${table.tableName}`);
    }
    if (table.workerCanDelete && !protectedTablesWithWorkerDelete.has(table.tableName)) {
      failures.push(`jarvis_worker_runtime can DELETE app.${table.tableName}`);
    }
  }

  for (const table of transientTables) {
    if (!presentTransientNames.has(table)) {
      failures.push(`missing transient table: ${table}`);
    }
  }
  for (const table of transientTableAudits) {
    if (!table.rlsEnabled) failures.push(`app.${table.tableName} does not enable RLS`);
    if (!table.forceRls) failures.push(`app.${table.tableName} does not force RLS`);
  }

  for (const table of authSecretTables) {
    if (!presentAuthSecretNames.has(table)) {
      failures.push(`missing auth secret table: ${table}`);
    }
  }
  for (const table of authSecretTableAudits) {
    if (!table.rlsEnabled) failures.push(`app.${table.tableName} does not enable RLS`);
    if (!table.forceRls) failures.push(`app.${table.tableName} does not force RLS`);
    if (table.appCanSelect) {
      failures.push(`jarvis_app_runtime can SELECT app.${table.tableName} (grant not revoked)`);
    }
  }

  for (const table of authOwnerTable) {
    if (!presentAuthOwnerNames.has(table)) {
      failures.push(`missing auth owner table: ${table}`);
    }
  }
  for (const table of authOwnerTableAudits) {
    if (!table.rlsEnabled) failures.push(`app.${table.tableName} does not enable RLS`);
    // Note: users uses ENABLE (not FORCE) RLS so the table owner (jarvis_migration_owner)
    // can bypass for SECURITY DEFINER functions. Auth secret tables keep FORCE.
  }

  if (!adminAuditPrivileges.appCanSelect) {
    failures.push("jarvis_app_runtime cannot SELECT app.admin_audit_events");
  }
  if (!adminAuditPrivileges.appCanInsert) {
    failures.push("jarvis_app_runtime cannot INSERT app.admin_audit_events");
  }
  if (adminAuditPrivileges.appCanUpdate) {
    failures.push("jarvis_app_runtime can UPDATE app.admin_audit_events");
  }
  if (adminAuditPrivileges.appCanDelete) {
    failures.push("jarvis_app_runtime can DELETE app.admin_audit_events");
  }
  // #671: handleWellnessExportJobInner (packages/wellness/src/export-job.ts) writes an audit
  // event from a worker-run job via the sanctioned recordAuditEvent() cross-module API, so
  // jarvis_worker_runtime needs INSERT+SELECT here (migration 0136) — documented exception to
  // the "app_runtime only" default. SELECT is granted for Postgres's own privilege check on the
  // INSERT statement; the _select RLS policy remains jarvis_app_runtime-only (confidentiality —
  // see 0059_admin_tables_rls.sql), so a worker SELECT still reads zero rows in practice. The
  // invariant stays strict: worker gets exactly INSERT+SELECT, nothing more.
  if (!adminAuditPrivileges.workerCanInsert) {
    failures.push("jarvis_worker_runtime cannot INSERT app.admin_audit_events (#671)");
  }
  if (!adminAuditPrivileges.workerCanSelect) {
    failures.push("jarvis_worker_runtime cannot SELECT app.admin_audit_events (#671)");
  }
  if (adminAuditPrivileges.workerCanUpdate) {
    failures.push("jarvis_worker_runtime can UPDATE app.admin_audit_events");
  }
  if (adminAuditPrivileges.workerCanDelete) {
    failures.push("jarvis_worker_runtime can DELETE app.admin_audit_events");
  }

  // Instance-admin tables must be RLS ENABLED and FORCED (migration 0059). Their
  // privilege shapes are asserted elsewhere (admin_audit_events above; instance_settings
  // writes are admin-gated by policy), so here we only verify the RLS posture so a
  // regression dropping FORCE/ENABLE fails this gate.
  const coverageByName = new Map(appSchemaCoverage.map((t) => [t.tableName, t]));
  for (const table of adminRlsTables) {
    const state = coverageByName.get(table);
    if (!state) {
      failures.push(`missing instance-admin table: ${table}`);
      continue;
    }
    if (!state.rlsEnabled) failures.push(`app.${table} does not enable RLS`);
    if (!state.forceRls) failures.push(`app.${table} does not force RLS`);
  }

  // Dynamic coverage check: every app-schema table must either have FORCE RLS
  // or appear in the explicit exemption list above. This ensures that adding a new
  // owner-data table without applying FORCE RLS causes this gate to fail automatically,
  // with no script edit required.
  const coveredByStaticChecks = new Set<string>([
    ...protectedTables,
    ...transientTables,
    ...authSecretTables,
    ...authOwnerTable,
    ...adminRlsTables
  ]);
  for (const table of appSchemaCoverage) {
    if (forceRlsExemptions.has(table.tableName)) {
      // Intentionally exempt — reason is documented in forceRlsExemptions above.
      continue;
    }
    if (!table.forceRls) {
      if (!coveredByStaticChecks.has(table.tableName)) {
        // Table exists in the app schema, has no FORCE RLS, and is not listed in any
        // known category. This is either a missing migration or a missing exemption entry.
        failures.push(
          `app.${table.tableName} is missing FORCE RLS and is not in the exemption list`
        );
      }
      // Tables in the static-check sets that are missing FORCE RLS are already reported
      // by the checks above; no duplicate failure needed here.
    }
  }

  return failures;
}

async function main(): Promise<void> {
  const report = await auditReleaseHardening();

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
