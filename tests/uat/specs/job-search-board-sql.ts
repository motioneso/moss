import { execFileSync } from "node:child_process";

import { buildUatComposeArgs } from "../provisioner.js";

// Shared direct-SQL-seed helper for the Setup/Phase 10/Phase 11 steps below (N40/N45): connects as
// the container's bootstrap superuser, not one of the four named app roles
// (infra/postgres/bootstrap/0000_roles.sql marks jarvis_migration_owner/app_runtime/worker_runtime/
// auth_runtime all NOBYPASSRLS), so this bypasses the FORCE RLS policies the same way a real
// migration/bootstrap connection does — there is no app-role path that could run these INSERTs.
// `-t -A` gives unaligned, headerless output so a `RETURNING` clause parses with a plain `.trim()`
// / `.split("|")` — but ONLY after the command tag is stripped. psql prints its tag ("INSERT 0 1",
// "UPDATE 1") on the line *after* the RETURNING row even under -t -A, so a raw return glues the tag
// onto the last column: a seeded uuid came back as "<uuid>\nINSERT 0 1" and Postgres rejected it as
// invalid uuid syntax on the next statement. Stripped here rather than at each call site, because
// every caller that adds a RETURNING clause would otherwise have to rediscover it.
const PSQL_COMMAND_TAG = /^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+)$/;

export function execUatSql(projectName: string, sql: string): string {
  const raw = execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      // The superuser, not a role named after the database. `infra/docker-compose.prod.yml` sets
      // POSTGRES_USER: postgres and POSTGRES_DB: jarv1s, so there is no `jarv1s` ROLE at all —
      // an earlier version of this helper assumed symmetry with the database name and every call
      // died with `FATAL: role "jarv1s" does not exist`. Only a live run could catch that; both
      // the compile and the whole unit/integration gate are blind to it.
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-t",
      "-A",
      "-c",
      sql
    ]),
    { encoding: "utf8" }
  );

  return raw
    .split("\n")
    .filter((line) => !PSQL_COMMAND_TAG.test(line.trim()))
    .join("\n");
}
