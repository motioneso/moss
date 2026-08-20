import type { Kysely } from "kysely";

import type { MossDatabase } from "../types.js";
import { loadMigrationFiles } from "./sql-runner.js";

export interface PendingMigration {
  readonly version: string;
  readonly name: string;
}

export interface MigrationDrift {
  readonly name: string;
  readonly appliedChecksum: string;
  readonly onDiskChecksum: string;
}

export interface MigrationStatus {
  readonly pending: readonly PendingMigration[];
  readonly drifted: readonly MigrationDrift[];
}

/**
 * Reads `app.schema_migrations` and compares it against the on-disk migration files in
 * `directories`, without applying anything. `sql-runner.ts`'s `runSqlMigrations` throws the
 * moment an applied checksum no longer matches disk (`Migration ${file.name} has changed after
 * being applied`); this function reports that condition as `drifted` instead, so a caller (the
 * dev-instance `doctor` command) can name the mismatch as the reason `pnpm db:migrate` will fail,
 * rather than crashing on the same check.
 */
export async function readMigrationStatus(
  db: Kysely<MossDatabase>,
  directories: readonly string[]
): Promise<MigrationStatus> {
  const applied = await db
    .selectFrom("app.schema_migrations")
    .select(["version", "name", "checksum"])
    .execute();
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  const pending: PendingMigration[] = [];
  const drifted: MigrationDrift[] = [];

  for (const directory of directories) {
    const files = await loadMigrationFiles(directory);

    for (const file of files) {
      const appliedRow = appliedByVersion.get(file.version);

      if (!appliedRow) {
        pending.push({ version: file.version, name: file.name });
        continue;
      }

      if (appliedRow.checksum !== file.checksum) {
        drifted.push({
          name: file.name,
          appliedChecksum: appliedRow.checksum,
          onDiskChecksum: file.checksum
        });
      }
    }
  }

  return { pending, drifted };
}
