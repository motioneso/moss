import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { readMigrationStatus } from "../migrations/pending.js";
import type { MossDatabase } from "../types.js";

interface AppliedRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function fakeDb(appliedRows: readonly AppliedRow[]): Kysely<MossDatabase> {
  return {
    selectFrom(table: string) {
      if (table !== "app.schema_migrations") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select() {
          return {
            async execute() {
              return appliedRows;
            }
          };
        }
      };
    }
  } as unknown as Kysely<MossDatabase>;
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moss-migration-status-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("readMigrationStatus", () => {
  it("reports nothing pending or drifted when every file is applied with a matching checksum", async () => {
    const sql = "SELECT 1;";
    await writeFile(join(directory, "0001_first.sql"), sql);
    const db = fakeDb([{ version: "0001", name: "0001_first.sql", checksum: checksumOf(sql) }]);

    const status = await readMigrationStatus(db, [directory]);

    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([]);
  });

  it("reports an unapplied file as pending", async () => {
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;");
    const db = fakeDb([]);

    const status = await readMigrationStatus(db, [directory]);

    expect(status.pending).toEqual([{ version: "0001", name: "0001_first.sql" }]);
    expect(status.drifted).toEqual([]);
  });

  it("reports a checksum mismatch as drifted, without throwing", async () => {
    const sql = "SELECT 1;";
    await writeFile(join(directory, "0001_first.sql"), sql);
    const db = fakeDb([{ version: "0001", name: "0001_first.sql", checksum: "stale-checksum" }]);

    const status = await readMigrationStatus(db, [directory]);

    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([
      {
        name: "0001_first.sql",
        appliedChecksum: "stale-checksum",
        onDiskChecksum: checksumOf(sql)
      }
    ]);
  });
});
