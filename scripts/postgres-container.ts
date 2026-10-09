import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { promisify } from "node:util";

import { sql, type Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";

const execFileAsync = promisify(execFile);

export const DEFAULT_POSTGRES_CONTAINER = "jarv1s-postgres";

/** Resolves the container that runs pg_dump/pg_restore: flag, then env, then the dev default. */
export function resolvePostgresContainer(flagValue?: string): string {
  return flagValue ?? process.env.JARVIS_BACKUP_PG_CONTAINER ?? DEFAULT_POSTGRES_CONTAINER;
}

/**
 * Runs `SELECT pg_try_advisory_lock(key)` inside the container. Advisory locks live in one
 * running server and one database, so a "false" answer means the lock is held by the session
 * on the configured URL and both reach the same instance.
 */
async function tryLockInContainer(input: ContainerTarget, key: number): Promise<boolean> {
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
      "--command",
      `SELECT pg_try_advisory_lock(${key})`
    ],
    { env: { ...process.env, PGPASSWORD: input.password } }
  );

  return stdout.trim() === "t";
}

export interface ContainerTarget {
  readonly container: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/**
 * pg_dump and pg_restore run inside a container and ignore the URL's host and port. Copies of a
 * cluster share a system identifier and database name, so identity cannot tell them apart.
 * Instead the URL connection takes a random advisory lock and the container must find it held.
 */
export async function assertContainerMatchesConnection(
  db: Kysely<MossDatabase>,
  input: ContainerTarget
): Promise<void> {
  const key = randomInt(1, 2 ** 31);

  await db.connection().execute(async (connection) => {
    await sql`SELECT pg_advisory_lock(${key})`.execute(connection);

    try {
      if (await tryLockInContainer(input, key)) {
        throw new Error(
          `Container "${input.container}" does not reach the Postgres server behind the ` +
            "configured URL. Refusing to continue. Set JARVIS_BACKUP_PG_CONTAINER (or pass " +
            "--container) to the container that runs the configured database."
        );
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${key})`.execute(connection);
    }
  });
}
