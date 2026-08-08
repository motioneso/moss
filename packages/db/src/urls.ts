import { resolveMossEnv } from "./env.js";

export const DEFAULT_JARVIS_DATABASE_NAME = "jarv1s";

export interface MossDatabaseUrls {
  readonly bootstrap: string;
  readonly migration: string;
  readonly app: string;
  readonly auth: string;
  readonly worker: string;
}

const DEFAULT_JARVIS_PGHOST = "localhost";
const DEFAULT_JARVIS_PGPORT = "55433";

// Requires an explicit `*_DATABASE_URL` (rather than a synthesized default-credential
// connection string) whenever either is true:
//   - NODE_ENV is production, or
//   - JARVIS_PGHOST/JARVIS_PGPORT point away from the coded local-dev defaults.
// The second condition closes a gap behind #1383: a dev shell with a stray/leaked
// JARVIS_PGHOST pointed at a real host (not production per NODE_ENV) would otherwise
// silently build a connection string using the hardcoded dev-default role passwords
// against that host instead of refusing outright.
function getExplicitDatabaseUrl(
  env: NodeJS.ProcessEnv,
  envVar: string,
  usesNonDefaultHostOrPort: boolean
): string | undefined {
  const value = resolveMossEnv(env, envVar);
  if (value) {
    return value;
  }
  if (env.NODE_ENV === "production") {
    throw new Error(`${envVar} is required in production`);
  }
  if (usesNonDefaultHostOrPort) {
    throw new Error(
      `${envVar} is required when JARVIS_PGHOST/JARVIS_PGPORT differ from the local dev ` +
        `defaults (${DEFAULT_JARVIS_PGHOST}:${DEFAULT_JARVIS_PGPORT}) — refusing to build a ` +
        "default-credentialed connection string against a non-default host/port."
    );
  }
  return undefined;
}

export function getMossDatabaseUrls(env: NodeJS.ProcessEnv = process.env): MossDatabaseUrls {
  const host = resolveMossEnv(env, "JARVIS_PGHOST") ?? DEFAULT_JARVIS_PGHOST;
  const port = resolveMossEnv(env, "JARVIS_PGPORT") ?? DEFAULT_JARVIS_PGPORT;
  // JARVIS_PGDATABASE is carved out: infra/backup-full.sh reads it directly on the host,
  // so it can't move behind this shim without breaking that script (see the Tier C carve-out
  // list). resolveMossEnv() passes carved-out names through unchanged, so this call is
  // future-proof if that ever changes, but today it's equivalent to env.JARVIS_PGDATABASE.
  const database = resolveMossEnv(env, "JARVIS_PGDATABASE") ?? DEFAULT_JARVIS_DATABASE_NAME;
  const usesNonDefaultHostOrPort = host !== DEFAULT_JARVIS_PGHOST || port !== DEFAULT_JARVIS_PGPORT;

  return {
    bootstrap:
      getExplicitDatabaseUrl(env, "JARVIS_BOOTSTRAP_DATABASE_URL", usesNonDefaultHostOrPort) ??
      `postgres://postgres:postgres@${host}:${port}/${database}`,
    migration:
      getExplicitDatabaseUrl(env, "JARVIS_MIGRATION_DATABASE_URL", usesNonDefaultHostOrPort) ??
      `postgres://jarvis_migration_owner:migration_password@${host}:${port}/${database}`,
    app:
      getExplicitDatabaseUrl(env, "JARVIS_APP_DATABASE_URL", usesNonDefaultHostOrPort) ??
      `postgres://jarvis_app_runtime:app_password@${host}:${port}/${database}`,
    auth:
      getExplicitDatabaseUrl(env, "JARVIS_AUTH_DATABASE_URL", usesNonDefaultHostOrPort) ??
      `postgres://jarvis_auth_runtime:auth_password@${host}:${port}/${database}`,
    worker:
      getExplicitDatabaseUrl(env, "JARVIS_WORKER_DATABASE_URL", usesNonDefaultHostOrPort) ??
      `postgres://jarvis_worker_runtime:worker_password@${host}:${port}/${database}`
  };
}
