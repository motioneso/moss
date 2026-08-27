import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WithClusterDdlLockOptions } from "@moss/db";
import {
  DEFAULT_JARVIS_DATABASE_NAME,
  getMossDatabaseUrls,
  resolveMossEnv,
  runSqlFiles,
  runSqlFilesWithClient,
  runSqlMigrations,
  withClusterDdlLock
} from "@moss/db";
import { migratePgBoss } from "@moss/jobs";
import { getAllQueueDefinitions, getBuiltInSqlMigrationDirectories } from "@moss/module-registry";
import pg from "pg";

const { Client } = pg;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const connectionStrings = getMossDatabaseUrls();

/** GreenMail test IMAP/SMTP server (infra/docker-compose.yml `greenmail` service, #641 Slice B). */
export const testImap = {
  host: resolveMossEnv(process.env, "JARVIS_TEST_IMAP_HOST") ?? "127.0.0.1",
  imapPort: Number(resolveMossEnv(process.env, "JARVIS_TEST_IMAP_PORT") ?? 3143),
  smtpPort: Number(resolveMossEnv(process.env, "JARVIS_TEST_IMAP_SMTP_PORT") ?? 3025),
  username: resolveMossEnv(process.env, "JARVIS_TEST_IMAP_USER") ?? "probe@greenmail.test",
  password: resolveMossEnv(process.env, "JARVIS_TEST_IMAP_PASSWORD") ?? "probe-pw"
};

export const ids = {
  userA: "00000000-0000-4000-8000-000000000001",
  userB: "00000000-0000-4000-8000-000000000002",
  adminUser: "00000000-0000-4000-8000-000000000003",
  /** Untouched by any other integration test's preference writes — safe for tests that assert
   * a preference key is absent before they run. Picked at 091/092 specifically because they are
   * outside every id block already claimed by other integration test files (checked against the
   * full repo-wide grep for this id prefix, not just this file). */
  userC: "00000000-0000-4000-8000-000000000091",
  userD: "00000000-0000-4000-8000-000000000092",
  sessionA: "40000000-0000-4000-8000-000000000001",
  sessionB: "40000000-0000-4000-8000-000000000002",
  sessionAdmin: "40000000-0000-4000-8000-000000000003",
  itemAOwnPrivate: "10000000-0000-4000-8000-000000000001",
  itemBPrivate: "10000000-0000-4000-8000-000000000002",
  itemBGrantedToA: "10000000-0000-4000-8000-000000000003",
  itemBSecondPrivate: "10000000-0000-4000-8000-000000000004"
} as const;

/**
 * Every built-in module, in registration order. Pinned on purpose: adding a module to the
 * registry is meant to be a conscious edit here, and the order is what the module list endpoint
 * and the navigation assertions depend on.
 *
 * This used to be nine hand-copied duplicates across seven integration test files, which meant
 * adding one module needed nine identical edits and pushed one of those files past the
 * file-length guard (#2013).
 */
export const expectedBuiltInModuleIds = [
  "settings",
  "connectors",
  "tasks",
  "jarvis.goals",
  "web",
  "notifications",
  "calendar",
  "email",
  "ai",
  "chat",
  "briefings",
  "memory",
  "usefulness-feedback",
  "structured-state",
  "wellness",
  "weather",
  "sports",
  "news",
  "notes",
  "proactive-monitoring",
  "jarvis.commitments",
  "people",
  "workflows",
  "workshop"
];

/**
 * Defense-in-depth: catches any direct `vitest run tests/integration` invocation that
 * bypasses `scripts/test-integration.ts` (which is the thing that actually provisions an
 * isolated database and sets JARVIS_PGDATABASE before vitest ever loads this module). Without
 * this, a reset silently drops+reseeds the shared dev database (#854).
 */
export function assertIsolatedTestDatabase(connectionString: string): void {
  const { pathname } = new URL(connectionString);
  const databaseName = pathname.replace(/^\//, "");

  if (databaseName === DEFAULT_JARVIS_DATABASE_NAME) {
    throw new Error(
      `Refusing to reset the shared "${DEFAULT_JARVIS_DATABASE_NAME}" database from an ` +
        "integration test. Run via `pnpm test:integration` (or the matching per-suite script), " +
        "which provisions an isolated database automatically, or set JARVIS_PGDATABASE yourself."
    );
  }
}

// jarvis_mod_ (11 chars) + slug + _runtime (8 chars, the longer of _runtime/_install) must
// stay within Postgres's 63-byte identifier limit after module-role-broker.ts's
// moduleSlugForRole() maps hyphens to underscores 1:1 (length-preserving) — so the slug
// budget is 63 - 11 - 8 = 44.
const ROLE_SLUG_MAX = 44;

/**
 * Derive a module id that is unique to this test lane's database, so two concurrent
 * integration-test lanes (separate JARVIS_PGDATABASE values) never generate the same
 * cluster-global jarvis_mod_<slug>_runtime/_install role names for the same fixture (#1625).
 */
export function laneScopedModuleId(
  base: string,
  connectionString: string = connectionStrings.bootstrap
): string {
  const { pathname } = new URL(connectionString);
  const laneIdentity = pathname.replace(/^\//, "");
  const laneHash = createHash("sha256").update(laneIdentity).digest("hex").slice(0, 8);
  const candidate = `${base}-${laneHash}`;
  if (candidate.length <= ROLE_SLUG_MAX) return candidate;
  // Deterministic collision-resistant shortening: hash the full candidate rather than
  // naive-truncate, so two long base names sharing a 44-char prefix don't collide.
  const shortHash = createHash("sha256").update(candidate).digest("hex").slice(0, 8);
  const budget = ROLE_SLUG_MAX - shortHash.length - 1;
  return `${base.slice(0, budget)}-${shortHash}`;
}

export async function resetFoundationDatabase(): Promise<void> {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetEmptyFoundationDatabase();
  await seedProbeData();
}

export async function resetEmptyFoundationDatabase(): Promise<void> {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await dropApplicationSchemas();
  // The bootstrap directory issues CREATE ROLE / ALTER ROLE, which write the cluster-global
  // pg_authid — shared by every gate database on this host. Two lanes resetting at once collide
  // with `tuple concurrently updated` (#1013), and this reset runs ~100 times per gate, so it is
  // by far the heaviest participant. Same shape as scripts/migrate.ts's production path (#1632).
  await withClusterDdlLock(connectionStrings.bootstrap, (client) =>
    runSqlFilesWithClient(client, join(root, "infra/postgres/bootstrap"))
  );
  await runSqlMigrations({
    connectionString: connectionStrings.migration,
    migrationsDirectory: join(root, "infra/postgres/migrations")
  });
  for (const moduleMigrationsDirectory of getBuiltInSqlMigrationDirectories()) {
    await runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: moduleMigrationsDirectory
    });
  }
  // Migration-level boss (distinct from the app-level boss #1124/#1128 patched) hits pg-boss's
  // native ~10s connectionTimeoutMillis default on every integration test's DB reset. Second
  // instance of the same bug class — see #1130.
  await migratePgBoss(connectionStrings.migration, getAllQueueDefinitions(), {
    connectionTimeoutMillis: 25_000
  });
  await runSqlFiles(connectionStrings.migration, join(root, "infra/postgres/grants"));
}

/**
 * Set an instance-wide setting from a test's arrange phase.
 *
 * Writes through the bootstrap superuser connection (same channel as seedProbeData),
 * which bypasses RLS. instance_settings UPDATE is admin-gated by policy (migration
 * 0059); production writes go through an admin DataContext (settings repository), and
 * test setup that only needs to arrange a precondition uses this privileged channel
 * rather than minting an admin actor — mirroring how seedProbeData seeds RLS-protected
 * tables. The value is stored as the jsonb wrapper the settings repository reads.
 */
export async function setInstanceSetting(
  key: string,
  value: Record<string, unknown>
): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query(
      `UPDATE app.instance_settings SET value = $1::jsonb, updated_at = now() WHERE key = $2`,
      [JSON.stringify(value), key]
    );
  } finally {
    await client.end();
  }
}

async function dropApplicationSchemas(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
  } finally {
    await client.end();
  }
}

async function seedProbeData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
        INSERT INTO app.users (id, email, is_instance_admin)
        VALUES
          ($1, 'user-a@example.test', false),
          ($2, 'user-b@example.test', false),
          ($3, 'admin@example.test', true),
          ($4, 'user-c@example.test', false),
          ($5, 'user-d@example.test', false)
      `,
      [ids.userA, ids.userB, ids.adminUser, ids.userC, ids.userD]
    );

    await client.query(
      `
        INSERT INTO app.auth_sessions (id, user_id, expires_at)
        VALUES
          ($1, $2, now() + interval '1 hour'),
          ($3, $4, now() + interval '1 hour'),
          ($5, $6, now() + interval '1 hour')
      `,
      [ids.sessionA, ids.userA, ids.sessionB, ids.userB, ids.sessionAdmin, ids.adminUser]
    );

    await client.query(
      `
        INSERT INTO app.rls_probe_items (id, owner_user_id, body)
        VALUES
          ($1, $2, 'user A private item'),
          ($3, $4, 'user B private item'),
          ($5, $4, 'user B item granted to user A'),
          ($6, $4, 'user B second private item')
      `,
      [
        ids.itemAOwnPrivate,
        ids.userA,
        ids.itemBPrivate,
        ids.userB,
        ids.itemBGrantedToA,
        ids.itemBSecondPrivate
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Options for the cluster-global DDL helpers below. `lock` is a pass-through to #1632's helper and
 * exists so `tests/unit/test-database-role-ddl-lock.test.ts` can pin routing through the DI seams
 * without a live cluster; suites never pass it.
 */
export interface ClusterGlobalDdlOptions {
  readonly lock?: WithClusterDdlLockOptions;
}

/**
 * Run cluster-global DDL under #1632's lock, on its guarded DDL session.
 *
 * One lock section per call, never one per statement: acquire/release is a cluster-wide
 * serialization point, and nesting sections to amortise it throws `ClusterDdlLockReentrancyError`
 * (the guard is process-global). Callers are safe to chain these back to back because vitest runs
 * suites sequentially here (`vitest.config.ts` — `pool: "forks"`, `fileParallelism: false`), so
 * every section is a sibling rather than a nested call.
 *
 * The connection string is the BOOTSTRAP url on purpose: the lock session swaps its database to
 * `JARVIS_CLUSTER_LOCK_DATABASE` itself, so every participant lands on one maintenance database and
 * the advisory-lock tags actually match.
 */
async function runClusterGlobalDdl(
  statements: readonly string[],
  options: ClusterGlobalDdlOptions,
  isTolerated: (error: unknown) => boolean = () => false
): Promise<void> {
  if (statements.length === 0) return;

  await withClusterDdlLock(
    connectionStrings.bootstrap,
    async (client) => {
      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (error) {
          if (!isTolerated(error)) throw error;
        }
      }
    },
    options.lock
  );
}

/**
 * Drop a module's per-module Postgres roles during teardown, tolerating the one failure that is
 * not ours to fix.
 *
 * Roles are CLUSTER-global, so `DROP ROLE` reaches past `JARVIS_PGDATABASE` into every database in
 * the instance. When the same module is also installed somewhere else — a developer's own `jarv1s`
 * database, or another agent's gate DB — the role still owns objects there and Postgres refuses the
 * drop with `dependent_objects_still_exist` (SQLSTATE 2BP01). That refusal is correct: the role
 * belongs to that other database, and dropping it would break it. It is also not a leak here, on
 * two counts: every REVOKE a suite runs before this point is per-database, so OUR database is
 * already clean; and `ensureModuleRoles` Phase A unconditionally resets a pre-existing role to
 * NOLOGIN PASSWORD NULL on every invocation, so a surviving role cannot carry login capability into
 * the next run. Any other error still throws. See issue #1345.
 *
 * Takes no caller connection (#1013): the drops run on the lock's guarded DDL session, and a
 * `client` parameter that no statement lands on would invite callers to assume otherwise — that
 * these drops join their transaction, or that they can be reordered against the per-database
 * REVOKEs above the call. They cannot; the REVOKEs must still complete first, on the caller's own
 * connection, or Postgres refuses the drop.
 */
export async function dropModuleRolesAtTeardown(
  roles: readonly string[],
  options: ClusterGlobalDdlOptions = {}
): Promise<void> {
  await runClusterGlobalDdl(
    roles.map((role) => `DROP ROLE IF EXISTS ${role}`),
    options,
    (error) => (error as { code?: string }).code === "2BP01"
  );
}

/**
 * Grant role membership (`GRANT <role> TO <role>`) from a suite's arrange phase.
 *
 * Membership lives in `pg_auth_members`, which is cluster-global exactly like `pg_authid` — so
 * these writes race across parallel gate databases the same way `DROP ROLE` does. Fail-closed: a
 * membership failure is a real cluster-catalog error, never another database's ownership claim, so
 * it gets none of `DROP ROLE`'s 2BP01 tolerance.
 */
export async function grantModuleMembershipAtSetup(
  statements: readonly string[],
  options: ClusterGlobalDdlOptions = {}
): Promise<void> {
  await runClusterGlobalDdl(statements, options);
}

/**
 * Revoke role membership during teardown. Cluster-global and fail-closed — see
 * {@link grantModuleMembershipAtSetup}.
 *
 * Call this BEFORE the per-database privilege REVOKEs that follow it in a suite's teardown:
 * Postgres refuses to revoke a grant-option privilege while a dependent downstream grant still
 * exists, so the membership has to go first. That ordering is why this is a separate lock section
 * from {@link dropModuleRolesAtTeardown} rather than one wrapping both.
 */
export async function revokeModuleMembershipAtTeardown(
  statements: readonly string[],
  options: ClusterGlobalDdlOptions = {}
): Promise<void> {
  await runClusterGlobalDdl(statements, options);
}
