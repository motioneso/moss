import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import pg from "pg";

import { LEGACY_UPGRADE_SHIMS, type LegacyUpgradeShims } from "./legacy-upgrade-shims.js";

const { Client } = pg;

export interface SqlMigrationRunnerOptions {
  readonly connectionString: string;
  readonly migrationsDirectory: string;
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
  /** Test seam; defaults to the shipped shims. */
  readonly legacyUpgradeShims?: LegacyUpgradeShims;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationRunResult {
  readonly applied: AppliedMigration[];
  readonly skipped: AppliedMigration[];
}

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
  /** Captured UTF-8 source; inspection never imports it or reads it again at execution. */
  readonly backfill?: { readonly name: string; readonly source: string };
}

/** Canonical first-party migrations only. External modules use module-sql-runner.ts. */
export async function runSqlMigrations(
  options: SqlMigrationRunnerOptions
): Promise<MigrationRunResult> {
  const migrationsSchema = options.migrationsSchema ?? "app";
  const migrationsTable = options.migrationsTable ?? "schema_migrations";
  const client = new Client({ connectionString: options.connectionString });
  const files = await readMigrationFiles(options.migrationsDirectory);
  const shims = options.legacyUpgradeShims ?? LEGACY_UPGRADE_SHIMS;
  const applied: AppliedMigration[] = [];
  const skipped: AppliedMigration[] = [];
  let lockAcquired = false;

  await client.connect();
  try {
    await acquireMigrationLock(client);
    lockAcquired = true;
    await ensureMigrationTable(client, migrationsSchema, migrationsTable);

    for (const file of files) {
      const existing = await client.query<{ checksum: string }>(
        `
          SELECT checksum
          FROM ${qualifiedIdentifier(migrationsSchema, migrationsTable)}
          WHERE version = $1
        `,
        [file.version]
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== file.checksum) {
          throw new Error(`Migration ${file.name} has changed after being applied`);
        }

        skipped.push(file);
        continue;
      }

      await client.query("BEGIN");
      try {
        const shim = shims[file.name];
        const restore = shim?.checksum === file.checksum ? await relaxForcedRls(client, shim) : [];
        await client.query(file.sql);
        if (file.backfill) {
          // Trusted first-party code, not a sandbox: globals remain available. A query-only
          // facade avoids coupling the frozen migration to connection lifecycle or new helpers.
          try {
            const sourceUrl = `data:text/javascript;base64,${Buffer.from(file.backfill.source).toString("base64")}`;
            const module: { backfill?: unknown } = await import(sourceUrl);
            if (typeof module.backfill !== "function") throw new Error("Missing backfill export");
            await module.backfill(Object.freeze({ query: client.query.bind(client) }));
          } catch {
            // Neither private historical payloads nor a data-URL source stack may reach logs.
            throw new Error(`Migration backfill ${file.backfill.name} failed`);
          }
        }
        for (const table of restore) {
          await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        }
        await client.query(
          `
            INSERT INTO ${qualifiedIdentifier(migrationsSchema, migrationsTable)}
              (version, name, checksum)
            VALUES ($1, $2, $3)
          `,
          [file.version, file.name, file.checksum]
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return { applied, skipped };
  } finally {
    if (lockAcquired) {
      await releaseMigrationLock(client);
    }
    await client.end();
  }
}

/**
 * Execute every `.sql` file in `directory` (sorted alphabetically) against the
 * given connection string.
 *
 * **Idempotency contract** (#168 LOW): every file in the bootstrap and grants
 * directories MUST be written as idempotent SQL — `CREATE OR REPLACE`,
 * `CREATE … IF NOT EXISTS`, `GRANT`, `ALTER ROLE … SET`, and similar
 * re-runnable statements are fine.  Unlike `runSqlMigrations`, this function
 * carries **no hash guard**: it re-executes every file on every call to
 * `pnpm db:migrate`.  If a file is not idempotent it will fail on the second
 * run.
 *
 * Each file is executed inside a transaction (BEGIN / COMMIT). A failure in
 * the middle of a file triggers ROLLBACK, leaving the database in the state
 * it was in before that file started, and the error is re-thrown.
 */
export async function runSqlFiles(connectionString: string, directory: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await runSqlFilesWithClient(client, directory);
  } finally {
    await client.end();
  }
}

/** The minimum a client must offer to execute SQL files — satisfied by both `pg.Client` and the
 * cluster-DDL lock's guarded DDL session, so a caller can run these files under the lock. */
export interface SqlFileClient {
  query(text: string): Promise<unknown>;
}

/**
 * The file loop of {@link runSqlFiles}, running on a caller-owned connection. Never connects or
 * ends the client: #1632's cluster-DDL lock hands in its guarded DDL session, whose statements are
 * refused the moment the separate lock-holding session's liveness is lost.
 */
export async function runSqlFilesWithClient(
  client: SqlFileClient,
  directory: string
): Promise<string[]> {
  const files = await readdir(directory);
  const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort();
  const executed: string[] = [];

  for (const fileName of sqlFiles) {
    const sql = await readFile(join(directory, fileName), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      executed.push(fileName);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  return executed;
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  return readMigrationFiles(directory);
}

export function assertUniqueMigrationVersions(files: MigrationFile[]): void {
  const seen = new Set<string>();
  const duplicates = files.map((f) => f.version).filter((v) => seen.size === seen.add(v).size);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate migration version numbers across directories: ${[...new Set(duplicates)].join(", ")}`
    );
  }
}

async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const files = await readdir(directory);

  return Promise.all(
    files
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map(async (fileName) => {
        const sqlBytes = await readFile(join(directory, fileName));
        const sql = decodeMigrationUtf8(sqlBytes, fileName);
        const [version] = fileName.split("_", 1);

        if (!version) {
          throw new Error(`Migration file ${fileName} is missing a version prefix`);
        }

        const backfillName = declaredBackfill(sql, fileName);
        if (!backfillName) {
          return {
            version,
            name: basename(fileName),
            checksum: createHash("sha256").update(sqlBytes).digest("hex"),
            sql
          };
        }

        const backfillBytes = await readFile(join(directory, backfillName));
        const source = decodeMigrationUtf8(backfillBytes, backfillName);
        return {
          version,
          name: basename(fileName),
          // Domain and explicit byte lengths distinguish this from the legacy SQL-only hash
          // and prevent ambiguous concatenation. Preserve every byte, including BOM/CRLF.
          checksum: createHash("sha256")
            .update("moss:sql-migration+backfill:v1\0")
            .update(`${sqlBytes.length}:`)
            .update(sqlBytes)
            .update(`${backfillBytes.length}:`)
            .update(backfillBytes)
            .digest("hex"),
          sql,
          backfill: { name: backfillName, source }
        };
      })
  );
}

function decodeMigrationUtf8(bytes: Uint8Array, name: string): string {
  try {
    // ignoreBOM preserves the BOM in the decoded source instead of stripping hashed bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Migration file ${name} must contain valid UTF-8`);
  }
}

function declaredBackfill(sql: string, name: string): string | undefined {
  const lines = sql.split(/\r?\n/).map((line) => line.trim());
  const declarations = lines.filter((line) => /^--\s*moss:backfill/.test(line));
  if (declarations.length === 0) return undefined;

  const declaration = declarations[0]!;
  const expectedName = name.replace(/\.sql$/, ".backfill.mjs");
  const header = lines.slice(0, lines.indexOf(declaration));
  if (
    declarations.length !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*\.backfill\.mjs$/.test(expectedName) ||
    declaration !== `-- moss:backfill ${expectedName}` ||
    header.some((line) => line !== "" && !line.startsWith("--"))
  ) {
    throw new Error(`Migration ${name} has an invalid backfill declaration`);
  }
  return expectedName;
}

async function ensureMigrationTable(
  client: pg.Client,
  schema: string,
  table: string
): Promise<void> {
  await client.query(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)} AUTHORIZATION CURRENT_USER`
  );
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${qualifiedIdentifier(schema, table)} (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function acquireMigrationLock(client: pg.Client): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext('jarv1s:migrations'))");
}

async function releaseMigrationLock(client: pg.Client): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext('jarv1s:migrations'))");
}

function qualifiedIdentifier(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }

  return `"${value}"`;
}

/** Lifts FORCE on the shim's tables and runs its prelude; returns the tables to re-force. */
async function relaxForcedRls(
  client: pg.Client,
  shim: NonNullable<LegacyUpgradeShims[string]>
): Promise<string[]> {
  const restore: string[] = [];
  for (const table of shim.relaxForcedRls) {
    const state = await client.query<{ forced: boolean }>(
      "SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
      [table]
    );
    if (state.rows[0]?.forced) {
      await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      restore.push(table);
    }
  }
  for (const statement of shim.before ?? []) await client.query(statement);
  return restore;
}
