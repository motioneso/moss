import { getMossDatabaseUrls } from "./urls.js";

// Compose service name and port of a UAT stack's own throwaway Postgres.
const UAT_STACK_DB_HOST = "postgres";
const UAT_STACK_DB_PORT = "5432";

// The driver lets query options (?host=, ?port=, ?dbname=, ?hostaddr=) override the
// address, so the host of the URL proves nothing when any are present. Stack URLs
// carry none, so any query string or fragment is refused.
function isUatStackDatabaseUrl(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.hostname === UAT_STACK_DB_HOST &&
    (parsed.port === "" || parsed.port === UAT_STACK_DB_PORT) &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

function pointsOnlyAtUatStackDatabase(env: NodeJS.ProcessEnv): boolean {
  try {
    return Object.values(getMossDatabaseUrls(env)).every(isUatStackDatabaseUrl);
  } catch {
    return false;
  }
}

/**
 * Backstop (#2989): the database a test or seed opens must come from a gate
 * run, never from a bare command typed next to the shared dev database.
 *
 * The PreToolUse hook (`.claude/hooks/check-gate-pipe.sh`) blocks the obvious
 * agent-typed forms, but hook matching will always miss some shell shape, so
 * the guarded setup paths check here, where the database is actually opened:
 * `scripts/test-integration.ts`, the integration-test resets in
 * `tests/integration/test-database.ts`, and the UAT seed connections in
 * `tests/uat/seed/connections.ts`.
 *
 * Allowed when the run-gate marker is set (exported by `scripts/run-gate.sh`
 * for the whole gate, in both name spells) or when the deliberate override
 * is set for a dev-database migration Ben asked for. A UAT stack's seed
 * container is also allowed: it carries the seed-confirm flag and every
 * database URL names the stack's own `postgres` service, so the shared dev
 * database (a different host) can never pass. Anything else throws
 * one plain line pointing at the verify-gate skill. There is deliberately no
 * CI carve-out: CI's integration job sets the override explicitly, so a bare
 * local run can never pass itself off as CI.
 */
export function assertGateRunDatabaseAccess(env: NodeJS.ProcessEnv = process.env): void {
  if (env.JARVIS_GATE_RUN === "1" || env.MOSS_GATE_RUN === "1") {
    return;
  }
  if (env.JARVIS_ALLOW_DIRECT_DB === "1") {
    return;
  }
  if (env.JARVIS_UAT_SEED_CONFIRM === "1" && pointsOnlyAtUatStackDatabase(env)) {
    return;
  }
  throw new Error(
    "BLOCKED: database-touching tests and migrates run only through the verify-gate skill (scripts/run-gate.sh)."
  );
}
