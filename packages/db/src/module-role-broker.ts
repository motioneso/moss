// Slice 2 (#914): per-module Postgres role lifecycle. Two roles per installed module:
// jarvis_mod_<slug>_runtime (NOLOGIN, granted to the parent runtime roles WITH INHERIT FALSE so
// they must SET LOCAL ROLE to use it — see module-storage-rpc.ts) and jarvis_mod_<slug>_install
// (NOLOGIN at rest, flipped to LOGIN with a random in-memory password only for the duration of
// Phase B, flipped back in Phase D regardless of outcome). Phase A (ensureModuleRoles)
// unconditionally resets the install role to NOLOGIN PASSWORD NULL on *every* invocation — not
// only at creation time — which is a stronger guarantee than 0000_roles.sql's create-time
// IF/ELSE pattern: it makes Phase A self-healing against a crash between Phase B
// (enableInstallerLogin) and Phase D (disableInstallerLogin), independent of Task 7's
// retry/cleanup logic. A retried Phase A always leaves the install role login-disabled.
import { createHash, randomBytes } from "node:crypto";

import { escapeIdentifier, escapeLiteral } from "pg";

import { withClusterDdlLock, type WithClusterDdlLockOptions } from "./cluster-ddl-lock.js";

// Mirrors packages/module-registry/src/external/validate.ts's MODULE_ID_RE. Duplicated rather
// than imported: module-registry already depends on @moss/db, so importing the other way would
// create a package cycle.
const MODULE_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function assertValidModuleId(moduleId: string): void {
  if (!MODULE_ID_RE.test(moduleId)) {
    throw new Error(`invalid module id "${moduleId}"`);
  }
}

function moduleSlugForRole(
  moduleId: string,
  scope: string | undefined = process.env.JARVIS_TEST_MODULE_ROLE_SCOPE
): string {
  assertValidModuleId(moduleId);
  const slug = moduleId.replace(/-/g, "_");
  // Test-only: the guarded integration runner scopes cluster-global roles to its database lane.
  // Production never sets this variable, so deployed role names remain byte-for-byte unchanged.
  if (!scope) return slug;
  const hash = createHash("sha256").update(`${moduleId}\0${scope}`).digest("hex").slice(0, 8);
  return `${slug.slice(0, 35)}_${hash}`;
}

export function moduleRuntimeRoleName(moduleId: string, scope?: string): string {
  return `jarvis_mod_${moduleSlugForRole(moduleId, scope)}_runtime`;
}

export function moduleInstallRoleName(moduleId: string, scope?: string): string {
  return `jarvis_mod_${moduleSlugForRole(moduleId, scope)}_install`;
}

export interface ModuleRoles {
  readonly runtimeRole: string;
  readonly installRole: string;
}

/**
 * Phase A: idempotently create both roles (NOLOGIN), grant the runtime role to the parent
 * runtime roles, and grant the install role its scoped schema-level privileges (USAGE+CREATE on
 * schema app, REFERENCES on app.users(id) for the mandatory owner FK) per spec D2.
 */
export async function ensureModuleRoles(
  connectionString: string,
  moduleId: string,
  options: WithClusterDdlLockOptions = {}
): Promise<ModuleRoles> {
  const runtimeRole = moduleRuntimeRoleName(moduleId);
  const installRole = moduleInstallRoleName(moduleId);
  return withClusterDdlLock(
    connectionString,
    async (client) => {
      for (const role of [runtimeRole, installRole]) {
        await client.query(
          `DO $$
         BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${escapeLiteral(role)}) THEN
             EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ' ||
               'NOINHERIT NOREPLICATION NOBYPASSRLS', '${role}');
           END IF;
         END $$;`
        );
      }
      // Unconditionally force the install role back to NOLOGIN PASSWORD NULL on EVERY call, not just
      // at creation. This makes Phase A itself the crash-recovery safety net: if a crash landed
      // between Phase B (enableInstallerLogin) and Phase D (disableInstallerLogin), a retried Phase A
      // clears the stale LOGIN + password regardless of whether Task 7's try/finally cleanup ran.
      await client.query(`ALTER ROLE ${escapeIdentifier(installRole)} NOLOGIN PASSWORD NULL`);
      await client.query(
        `GRANT ${escapeIdentifier(runtimeRole)} TO jarvis_app_runtime, jarvis_worker_runtime ` +
          `WITH INHERIT FALSE`
      );
      // Scoped install-role privileges per spec D2: enough to CREATE its own tables under schema
      // app and FK-reference app.users(id) — nothing else. GRANT is idempotent (re-granting an
      // already-held privilege is a no-op), so this is safe on every call, not just at creation.
      await client.query(`GRANT CREATE ON SCHEMA app TO ${escapeIdentifier(installRole)}`);
      // USAGE (and EXECUTE on the RLS-predicate function) need WITH GRANT OPTION: Phase B's
      // generated RLS (module-rls-emitter.ts) re-grants both onward to the module's own runtime
      // role from an installer-role connection, not this bootstrap/superuser one. Without grant
      // option Postgres silently no-ops the re-grant (no error, ACL unchanged) rather than failing
      // loud — a footgun discovered via a manual ACL inspection, not a thrown error.
      await client.query(
        `GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(installRole)} WITH GRANT OPTION`
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION app.current_actor_user_id() TO ` +
          `${escapeIdentifier(installRole)} WITH GRANT OPTION`
      );
      await client.query(`GRANT REFERENCES (id) ON app.users TO ${escapeIdentifier(installRole)}`);
      return { runtimeRole, installRole };
    },
    options
  );
}

/** Phase A/B boundary: flips the installer role to LOGIN with a fresh random password, returned only in memory. */
export async function enableInstallerLogin(
  connectionString: string,
  moduleId: string,
  options: WithClusterDdlLockOptions = {}
): Promise<string> {
  const installRole = moduleInstallRoleName(moduleId);
  const password = randomBytes(24).toString("base64url");
  await withClusterDdlLock(
    connectionString,
    async (client) => {
      await client.query(
        `ALTER ROLE ${escapeIdentifier(installRole)} LOGIN PASSWORD ` + escapeLiteral(password)
      );
    },
    options
  );
  return password;
}

/** Phase D: flips the installer role back to NOLOGIN and clears its password, regardless of install outcome. */
export async function disableInstallerLogin(
  connectionString: string,
  moduleId: string,
  options: WithClusterDdlLockOptions = {}
): Promise<void> {
  const installRole = moduleInstallRoleName(moduleId);
  return withClusterDdlLock(
    connectionString,
    async (client) => {
      await client.query(`ALTER ROLE ${escapeIdentifier(installRole)} NOLOGIN PASSWORD NULL`);
    },
    options
  );
}
