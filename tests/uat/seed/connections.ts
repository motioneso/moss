import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";

import { DataContextRunner, type MossDatabase } from "@moss/db";
import { assertGateRunDatabaseAccess, getMossDatabaseUrls } from "@moss/db";

/**
 * #1025 hard invariant (tier=sensitive): dev-only privileged connection for the
 * app.users / app.auth_accounts bootstrap ONLY (spec §4.1). jarvis_migration_owner
 * is migration-class tooling — NOSUPERUSER/NOBYPASSRLS, member of jarvis_auth_runtime
 * only (infra/postgres/bootstrap/0000_roles.sql) — never grant it BYPASSRLS or widen
 * it to jarvis_app_runtime; that would violate the "no BYPASSRLS on runtime roles"
 * hard invariant (CLAUDE.md) by turning migration-owner into a de facto bypass role.
 */
export function createMigrationOwnerDb(): Kysely<MossDatabase> {
  // Backstop (#2989): refuse a bare seed outside a gate. Unit tests mock
  // this module, so they never reach this.
  assertGateRunDatabaseAccess();
  const { migration } = getMossDatabaseUrls();
  return new Kysely<MossDatabase>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: migration }) })
  });
}

/**
 * #1025: every feature chunk (news/sports/tasks/calendar/notes) writes through this
 * connection + DataContextRunner.withDataContext, exactly the path production
 * requests take. jarvis_migration_owner cannot write these tables — every
 * feature table in this codebase has FORCE ROW LEVEL SECURITY scoped
 * `TO jarvis_app_runtime` (confirmed via `grep -rn "FORCE ROW LEVEL SECURITY"
 * packages/*\/sql/*.sql`), and jarvis_migration_owner is not a member of that
 * role. Using the real app_runtime connection + real repository methods means
 * every seeded row is written exactly the way a real request would write it —
 * no RLS carve-out, no bypass.
 */
export function createAppRuntimeRunner(): DataContextRunner & { destroy(): Promise<void> } {
  assertGateRunDatabaseAccess();
  const { app } = getMossDatabaseUrls();
  const rootDb = new Kysely<MossDatabase>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: app }) })
  });
  return Object.assign(new DataContextRunner(rootDb), { destroy: () => rootDb.destroy() });
}
