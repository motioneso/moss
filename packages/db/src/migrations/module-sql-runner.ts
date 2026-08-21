// Slice 1 (#914): wire-contract validator for external-module migration files. Every module
// migration must be exactly one statement whose first command is on a narrow allowlist — this is
// the ONLY security-relevant SQL a module author ever writes; everything else (RLS, policies,
// grants) is platform-generated (module-rls-emitter.ts) so a module can never grant itself access
// it shouldn't have.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "pg";

const FIRST_COMMAND_ALLOWLIST: readonly RegExp[] = [
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /^ALTER\s+TABLE\b/i,
  /^DROP\s+INDEX\b/i,
  /^COMMENT\s+ON\b/i,
  /^UPDATE\b/i,
  /^DELETE\b/i
];

export interface ModuleMigrationValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function validateModuleMigrationSql(sql: string): ModuleMigrationValidation {
  const errors: string[] = [];
  const stripped = stripSqlComments(sql).trim();

  if (stripped.length === 0) {
    return { ok: false, errors: ["migration file is empty"] };
  }

  const statementCount = countTopLevelStatements(stripped);
  if (statementCount !== 1) {
    errors.push(`expected exactly one SQL statement, found ${statementCount}`);
  }

  if (!FIRST_COMMAND_ALLOWLIST.some((pattern) => pattern.test(stripped))) {
    errors.push(
      "first command must be one of: CREATE TABLE, CREATE [UNIQUE] INDEX, ALTER TABLE, " +
        "DROP INDEX, COMMENT ON, UPDATE, DELETE"
    );
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Strips `--` line comments and block comments,
 * passing string literals through untouched.
 */
function stripSqlComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    const twoChar = sql.slice(i, i + 2);
    if (twoChar === "--") {
      const newlineIndex = sql.indexOf("\n", i);
      i = newlineIndex === -1 ? sql.length : newlineIndex + 1;
      continue;
    }
    if (twoChar === "/*") {
      const endIndex = sql.indexOf("*/", i + 2);
      i = endIndex === -1 ? sql.length : endIndex + 2;
      continue;
    }
    if (sql[i] === "'") {
      const end = findStringLiteralEnd(sql, i);
      result += sql.slice(i, end);
      i = end;
      continue;
    }
    result += sql[i];
    i += 1;
  }
  return result;
}

/**
 * `start` must index the opening `'`.
 * Returns the index just past the closing `'` (handles `''` escapes).
 */
function findStringLiteralEnd(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function countTopLevelStatements(sql: string): number {
  let count = 0;
  let i = 0;
  let sawContentSinceSemicolon = false;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = findStringLiteralEnd(sql, i);
      sawContentSinceSemicolon = true;
      i = end;
      continue;
    }
    if (sql[i] === ";") {
      if (sawContentSinceSemicolon) count += 1;
      sawContentSinceSemicolon = false;
      i += 1;
      continue;
    }
    if (!/\s/.test(sql[i]!)) sawContentSinceSemicolon = true;
    i += 1;
  }
  if (sawContentSinceSemicolon) count += 1;
  return count;
}

export interface ModuleMigrationFile {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

/**
 * Loads every `.sql` file in `directory`, sorted by filename, validating each against the wire
 * contract. A missing `directory` returns `[]` rather than throwing: external modules with no
 * database tables ship no `sql/` dir at all, which is a valid, common shape —
 * not an error. Reconcile (#1007) was pinning every DB-less module `disabled` /
 * `database install failed` because the raw ENOENT propagated as a hard failure. Any other
 * readdir error (permissions, not-a-directory, etc.) still rethrows.
 */
export async function loadModuleMigrationFiles(directory: string): Promise<ModuleMigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = names.filter((name) => name.endsWith(".sql")).sort();
  const files: ModuleMigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(join(directory, name), "utf8");
    const validation = validateModuleMigrationSql(sql);
    if (!validation.ok) {
      throw new Error(
        `module migration ${name} violates the wire contract: ${validation.errors.join("; ")}`
      );
    }
    const version = name.split("_")[0]!;
    files.push({ version, name, checksum: createHash("sha256").update(sql).digest("hex"), sql });
  }
  return files;
}

/** Returns the set of migration versions already recorded for `moduleId`. */
export async function getAppliedModuleMigrations(
  connectionString: string,
  moduleId: string
): Promise<Set<string>> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ version: string }>(
      "SELECT version FROM app.module_schema_migrations WHERE module_id = $1",
      [moduleId]
    );
    return new Set(result.rows.map((row) => row.version));
  } finally {
    await client.end();
  }
}

/** Records ledger rows for `files` under `moduleId` (Phase C — runs over the migration-owner connection). */
export async function recordModuleMigrations(
  connectionString: string,
  moduleId: string,
  files: readonly ModuleMigrationFile[]
): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const file of files) {
      await client.query(
        "INSERT INTO app.module_schema_migrations (module_id, version, name, checksum) " +
          "VALUES ($1, $2, $3, $4)",
        [moduleId, file.version, file.name, file.checksum]
      );
    }
  } finally {
    await client.end();
  }
}
