import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sql, type Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";

const execFileAsync = promisify(execFile);

export const DEFAULT_POSTGRES_CONTAINER = "jarv1s-postgres";

export interface DatabaseIdentity {
  readonly database: string;
  readonly systemIdentifier: string;
}

/** Resolves the container that runs pg_dump/pg_restore: flag, then env, then the dev default. */
export function resolvePostgresContainer(flagValue?: string): string {
  return flagValue ?? process.env.JARVIS_BACKUP_PG_CONTAINER ?? DEFAULT_POSTGRES_CONTAINER;
}

/** Identity of the database behind a Kysely connection (the URL the operator confirmed). */
export async function readConnectionIdentity(db: Kysely<MossDatabase>): Promise<DatabaseIdentity> {
  const result = await sql<{ database: string; system_identifier: string }>`
    SELECT current_database() AS database, system_identifier::text AS system_identifier
    FROM pg_control_system()
  `.execute(db);
  const row = result.rows[0];

  if (!row) {
    throw new Error("Could not read the identity of the configured database");
  }

  return { database: row.database, systemIdentifier: row.system_identifier };
}

/** Identity of the database the container's own client tools reach for the same credentials. */
export async function readContainerIdentity(input: {
  readonly container: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}): Promise<DatabaseIdentity> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "exec",
      "--env",
      "PGPASSWORD",
      input.container,
      "psql",
      "--username",
      input.username,
      "--dbname",
      input.database,
      "--tuples-only",
      "--no-align",
      "--field-separator",
      "|",
      "--command",
      "SELECT current_database(), system_identifier::text FROM pg_control_system()"
    ],
    { env: { ...process.env, PGPASSWORD: input.password } }
  );
  const [database, systemIdentifier] = stdout.trim().split("|");

  if (!database || !systemIdentifier) {
    throw new Error(`Could not read the database identity inside container "${input.container}"`);
  }

  return { database, systemIdentifier };
}

/**
 * pg_dump and pg_restore run inside a container and ignore the URL's host and port. This proves
 * the container reaches the same Postgres server and database the operator confirmed.
 */
export function assertSameDatabase(
  confirmed: DatabaseIdentity,
  actual: DatabaseIdentity,
  container: string
): void {
  if (
    confirmed.systemIdentifier !== actual.systemIdentifier ||
    confirmed.database !== actual.database
  ) {
    throw new Error(
      `Container "${container}" reaches database "${actual.database}" on a different Postgres ` +
        `server than the configured URL ("${confirmed.database}"). Refusing to continue. ` +
        "Set JARVIS_BACKUP_PG_CONTAINER (or pass --container) to the container that runs " +
        "the configured database."
    );
  }
}

export async function assertContainerMatchesConnection(
  db: Kysely<MossDatabase>,
  input: {
    readonly container: string;
    readonly database: string;
    readonly username: string;
    readonly password: string;
  }
): Promise<void> {
  const [confirmed, actual] = await Promise.all([
    readConnectionIdentity(db),
    readContainerIdentity(input)
  ]);

  assertSameDatabase(confirmed, actual, input.container);
}
