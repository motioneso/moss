import { escapeIdentifier, escapeLiteral } from "pg";

import { withClusterDdlLock, type WithClusterDdlLockOptions } from "./cluster-ddl-lock.js";
import type { MossDatabaseUrls } from "./urls.js";

export interface RolePasswordEntry {
  readonly role: string;
  readonly password: string;
}

/**
 * The development-default role passwords historically committed in the bootstrap
 * SQL and still used as local fallbacks by `getMossDatabaseUrls`. A production
 * bootstrap must never run with any of these.
 */
export const RUNTIME_ROLE_PASSWORD_DEFAULTS: ReadonlySet<string> = new Set([
  "migration_password",
  "app_password",
  "worker_password",
  "auth_password"
]);

const ROLE_URL_SOURCES: ReadonlyArray<{
  readonly role: string;
  readonly url: keyof MossDatabaseUrls;
}> = [
  { role: "jarvis_migration_owner", url: "migration" },
  { role: "jarvis_app_runtime", url: "app" },
  { role: "jarvis_worker_runtime", url: "worker" },
  { role: "jarvis_auth_runtime", url: "auth" }
];

/**
 * Derive the bootstrap role-password plan from the configured connection URLs.
 *
 * The connection URLs are the single source of truth: the same password used to
 * connect as a runtime role is the password the bootstrap step assigns to it, so
 * the two can never drift. Outside production the local dev fallbacks (which carry
 * the development-default passwords) are accepted as-is. In production the plan
 * fails closed — it refuses when any role password is missing or is still a
 * development default. Error messages name the role only, never the password.
 */
export function buildRolePasswordPlan(
  urls: MossDatabaseUrls,
  env: NodeJS.ProcessEnv = process.env
): RolePasswordEntry[] {
  const isProduction = env.NODE_ENV === "production";

  return ROLE_URL_SOURCES.map(({ role, url }) => {
    // `URL.password` is the percent-encoded userinfo component. The pg driver decodes it via
    // decodeURIComponent when it connects (pg-connection-string), so decode here too — otherwise
    // a role password containing URL-reserved characters would be ALTER ROLE'd in its encoded form
    // while the runtime authenticates with the decoded form, and the role could never log in.
    const password = decodeURIComponent(new URL(urls[url]).password);

    if (isProduction) {
      if (!password) {
        throw new Error(
          `Role ${role} has no password in its configured connection URL; ` +
            `production role bootstrap cannot proceed.`
        );
      }
      if (RUNTIME_ROLE_PASSWORD_DEFAULTS.has(password)) {
        throw new Error(
          `Role ${role} is configured with a development-default password; ` +
            `refusing to bootstrap it in production.`
        );
      }
    }

    return { role, password };
  });
}

/**
 * Build the idempotent `ALTER ROLE` statement that assigns one role's password.
 * The role name and password are escaped via `pg`'s module-level
 * `escapeIdentifier`/`escapeLiteral` — the same functions `pg.Client`'s instance
 * methods delegate to — so arbitrary configured secrets cannot break out of the
 * statement without needing a live client to escape with.
 */
export function buildAlterRoleStatement(entry: RolePasswordEntry): string {
  return (
    `ALTER ROLE ${escapeIdentifier(entry.role)} ` +
    `WITH LOGIN PASSWORD ${escapeLiteral(entry.password)}`
  );
}

/**
 * Apply a role-password plan against the bootstrap (superuser) connection.
 *
 * Roles are created without passwords by the bootstrap SQL; this step assigns
 * each role its configured password. It is idempotent — re-running re-applies the
 * same configured secret, so repeated `pnpm db:migrate` runs never reset a role to
 * a development default.
 */
export async function applyRolePasswords(
  connectionString: string,
  plan: RolePasswordEntry[],
  options: WithClusterDdlLockOptions = {}
): Promise<void> {
  return withClusterDdlLock(
    connectionString,
    async (client) => {
      for (const entry of plan) {
        await client.query(buildAlterRoleStatement(entry));
      }
    },
    options
  );
}
