import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadModuleMigrationFiles } from "../../packages/db/src/migrations/module-sql-runner.js";
import { readMigrationStatus } from "../../packages/db/src/migrations/pending.js";
import {
  loadMigrationFiles,
  runSqlFilesWithClient,
  runSqlMigrations
} from "../../packages/db/src/migrations/sql-runner.js";
import type { MossDatabase } from "../../packages/db/src/types.js";
import { installModule } from "../../scripts/module-install.js";

const fixture = vi.hoisted(() => ({
  queries: [] as { text: string; values?: unknown[] }[],
  ledger: new Map<string, string>(),
  connected: 0,
  ended: 0,
  onQuery: undefined as ((text: string) => Promise<void>) | undefined
}));

vi.mock("pg", () => {
  class Client {
    async connect() {
      fixture.connected++;
    }
    async end() {
      fixture.ended++;
    }
    async query(text: string, values?: unknown[]) {
      // A detached, unbound pg query method fails in reality. Assert the receiver here too.
      if (!(this instanceof Client)) throw new Error("unbound client");
      fixture.queries.push({ text, values });
      await fixture.onQuery?.(text);
      if (text.includes("SELECT checksum")) {
        const checksum = fixture.ledger.get(String(values?.[0]));
        return { rows: checksum ? [{ checksum }] : [] };
      }
      if (text.includes('INSERT INTO "app"."schema_migrations"')) {
        fixture.ledger.set(String(values?.[0]), String(values?.[2]));
      }
      return { rows: [{ value: "query-result" }] };
    }
  }
  return { default: { Client }, Client };
});

// Exercise the real external installer and wire loader without any role or database operation.
vi.mock("@moss/db", async () => ({
  assertQualifiedTableName: vi.fn(),
  disableInstallerLogin: vi.fn(async () => undefined),
  enableInstallerLogin: vi.fn(async () => "synthetic-unused-password"),
  ensureModuleRoles: vi.fn(async () => ({
    runtimeRole: "fixture_runtime",
    installRole: "fixture_install"
  })),
  generateModuleTableRlsSql: vi.fn(() => []),
  getAppliedModuleMigrations: vi.fn(async () => new Set<string>()),
  loadModuleMigrationFiles: (await import("../../packages/db/src/migrations/module-sql-runner.js"))
    .loadModuleMigrationFiles,
  recordModuleMigrations: vi.fn(async () => undefined)
}));

const sqlName = "0001_fixture.sql";
const sidecarName = "0001_fixture.backfill.mjs";
const header = `-- moss:backfill ${sidecarName}`;
const sql = `${header}\nSELECT 'migration';\n`;
const source = `export async function backfill(client) {
  if (Object.keys(client).join() !== "query" || !Object.isFrozen(client)) {
    throw new Error("unexpected client facade");
  }
  const { query } = client;
  const result = await query("SELECT 'backfill'", ["parameter"]);
  await query("SELECT 'awaited'", [result.rows[0].value]);
}`;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moss-sql-backfill-"));
  fixture.queries.length = 0;
  fixture.ledger.clear();
  fixture.connected = 0;
  fixture.ended = 0;
  fixture.onQuery = undefined;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeFixture(backfill: string | Uint8Array = source, sqlSource = sql) {
  await writeFile(join(directory, sqlName), sqlSource);
  await writeFile(join(directory, sidecarName), backfill);
}

function migrate() {
  return runSqlMigrations({
    connectionString: "postgresql://unused.invalid/synthetic",
    migrationsDirectory: directory
  });
}

function statusDb(): Kysely<MossDatabase> {
  return {
    selectFrom: () => ({
      select: () => ({
        execute: async () =>
          [...fixture.ledger].map(([version, checksum]) => ({ version, name: sqlName, checksum }))
      })
    })
  } as unknown as Kysely<MossDatabase>;
}

describe("canonical SQL migration sidecars", () => {
  it("preserves exact SQL-only SHA256 including BOM, Unicode and CRLF", async () => {
    const bytes = Buffer.from("\ufeff-- héllo 🌱\r\nSELECT 1;\r\n");
    await writeFile(join(directory, sqlName), bytes);
    await writeFile(join(directory, sidecarName), "throw new Error('must not import');");
    const [file] = await loadMigrationFiles(directory);
    expect(file).toEqual({
      version: "0001",
      name: sqlName,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      sql: bytes.toString("utf8")
    });
    await migrate();
    expect(fixture.queries.some((query) => query.text === "COMMIT")).toBe(true);
  });

  it("hashes domain-separated lengths and both exact byte strings without importing", async () => {
    const sidecar = "\ufeffthrow new Error('inspection must not import 🌱');\r\n";
    await writeFixture(sidecar);
    const [file] = await loadMigrationFiles(directory);
    expect(file?.checksum).toBe(
      createHash("sha256")
        .update("moss:sql-migration+backfill:v1\0")
        .update(`${Buffer.byteLength(sql)}:`)
        .update(sql)
        .update(`${Buffer.byteLength(sidecar)}:`)
        .update(sidecar)
        .digest("hex")
    );
    expect(file?.backfill).toEqual({ name: sidecarName, source: sidecar });
    expect(file?.checksum).not.toBe(
      createHash("sha256")
        .update(sql + sidecar)
        .digest("hex")
    );
    expect(fixture.connected).toBe(0);
  });

  it("reports pending and changed sidecar bytes as drift without executing source", async () => {
    await writeFixture("throw new Error('never import for status');");
    const [file] = await loadMigrationFiles(directory);
    expect(await readMigrationStatus(statusDb(), [directory])).toEqual({
      pending: [{ version: "0001", name: sqlName }],
      drifted: []
    });
    fixture.ledger.set("0001", file!.checksum);
    expect(await readMigrationStatus(statusDb(), [directory])).toEqual({
      pending: [],
      drifted: []
    });
    await writeFile(
      join(directory, sidecarName),
      "throw new Error('changed, still never import');"
    );
    const [changed] = await loadMigrationFiles(directory);
    expect(await readMigrationStatus(statusDb(), [directory])).toEqual({
      pending: [],
      drifted: [
        { name: sqlName, appliedChecksum: file!.checksum, onDiskChecksum: changed!.checksum }
      ]
    });
    await expect(migrate()).rejects.toThrow("has changed after being applied");
    expect(fixture.queries.some((query) => query.text === "BEGIN")).toBe(false);
  });

  it("fails closed on a missing declared sidecar for load, status and fresh application", async () => {
    await writeFile(join(directory, sqlName), sql);
    await expect(loadMigrationFiles(directory)).rejects.toThrow("ENOENT");
    await expect(readMigrationStatus(statusDb(), [directory])).rejects.toThrow("ENOENT");
    await expect(migrate()).rejects.toThrow("ENOENT");
    expect(fixture.connected).toBe(0);
  });

  it("fails closed when an applied sidecar is removed", async () => {
    await writeFixture();
    const [file] = await loadMigrationFiles(directory);
    fixture.ledger.set("0001", file!.checksum);
    await rm(join(directory, sidecarName));
    await expect(readMigrationStatus(statusDb(), [directory])).rejects.toThrow("ENOENT");
    await expect(migrate()).rejects.toThrow("ENOENT");
    expect(fixture.connected).toBe(0);
  });

  it.each([
    "-- moss:backfill ../0001_fixture.backfill.mjs",
    "-- moss:backfill /tmp/0001_fixture.backfill.mjs",
    "-- moss:backfill C:\\tmp\\0001_fixture.backfill.mjs",
    "-- moss:backfill 0002_other.backfill.mjs",
    "-- moss:backfill ./0001_fixture.backfill.mjs",
    "-- moss:backfill 0001_fixture.mjs",
    "-- moss:backfill",
    "-- moss:backfill: 0001_fixture.backfill.mjs",
    `${header} extra`,
    `${header}\n${header}`,
    `SELECT 1;\n${header}`
  ])("rejects malformed or noncanonical declaration %s", async (declaration) => {
    await writeFixture(source, `${declaration}\nSELECT 1;`);
    await expect(loadMigrationFiles(directory)).rejects.toThrow("invalid backfill declaration");
    expect(fixture.connected).toBe(0);
  });

  it.each(["sql", "sidecar"])("rejects invalid UTF-8 in %s before connecting", async (target) => {
    await writeFixture();
    await writeFile(
      join(directory, target === "sql" ? sqlName : sidecarName),
      Buffer.from([0xc3, 0x28])
    );
    await expect(loadMigrationFiles(directory)).rejects.toThrow("must contain valid UTF-8");
    await expect(migrate()).rejects.toThrow("must contain valid UTF-8");
    expect(fixture.connected).toBe(0);
  });

  it("runs SQL, the awaited query-only sidecar, then the ledger under one lock and transaction", async () => {
    await writeFixture();
    const result = await migrate();
    const texts = fixture.queries.map((query) => query.text);
    const begin = texts.indexOf("BEGIN");
    expect(texts[0]).toContain("pg_advisory_lock");
    expect(texts.slice(begin, begin + 4)).toEqual([
      "BEGIN",
      sql,
      "SELECT 'backfill'",
      "SELECT 'awaited'"
    ]);
    expect(fixture.queries[begin + 2]?.values).toEqual(["parameter"]);
    expect(fixture.queries[begin + 3]?.values).toEqual(["query-result"]);
    expect(texts[begin + 4]).toContain('INSERT INTO "app"."schema_migrations"');
    expect(texts.slice(begin + 5)).toEqual([
      "COMMIT",
      "SELECT pg_advisory_unlock(hashtext('jarv1s:migrations'))"
    ]);
    expect(result.applied.map((file) => file.version)).toEqual(["0001"]);
    expect(fixture.connected).toBe(1);
    expect(fixture.ended).toBe(1);
  });

  it("executes captured valid multibyte source including its UTF-8 BOM", async () => {
    await writeFixture(
      '\ufeffexport async function backfill(client) {\r\nawait client.query("SELECT \'unicode\'", ["é🌱"]);\r\n}\r\n'
    );
    await migrate();
    expect(fixture.queries.find((query) => query.text === "SELECT 'unicode'")?.values).toEqual([
      "é🌱"
    ]);
  });

  it("preserves SQL failure handling and never enters the sidecar after SQL fails", async () => {
    await writeFixture();
    const failure = new Error("legacy SQL failure");
    fixture.onQuery = async (text) => {
      if (text === sql) throw failure;
    };
    await expect(migrate()).rejects.toBe(failure);
    expect(fixture.queries.some((query) => query.text === "SELECT 'backfill'")).toBe(false);
    expect(fixture.queries.some((query) => query.text === "ROLLBACK")).toBe(true);
    expect(fixture.ledger.size).toBe(0);
  });

  it("executes the hashed captured source even if the sidecar changes after loading", async () => {
    await writeFixture();
    fixture.onQuery = async (text) => {
      if (text === sql) {
        await writeFile(join(directory, sidecarName), "throw new Error('re-read changed bytes');");
      }
    };
    const [captured] = await loadMigrationFiles(directory);
    await migrate();
    expect(fixture.queries.some((query) => query.text === "SELECT 'backfill'")).toBe(true);
    expect(fixture.ledger.get("0001")).toBe(captured!.checksum);
    const [changed] = await loadMigrationFiles(directory);
    expect(changed!.checksum).not.toBe(captured!.checksum);
  });

  it.each([
    "export async function backfill(client) { await client.query(\"SELECT 'before failure'\"); throw new Error('backfill failed'); }",
    "throw new Error('backfill failed at import');",
    "export const notBackfill = true;"
  ])(
    "rolls back without a ledger entry when sidecar loading or execution fails",
    async (failure) => {
      await writeFixture(failure);
      await expect(migrate()).rejects.toThrow(/backfill/);
      const texts = fixture.queries.map((query) => query.text);
      expect(texts).toContain(sql);
      expect(texts).toContain("ROLLBACK");
      expect(texts).not.toContain("COMMIT");
      expect(texts.some((text) => text.includes("INSERT INTO"))).toBe(false);
      expect(fixture.ledger.size).toBe(0);
      expect(fixture.ended).toBe(1);
    }
  );

  it("retries an unchanged failed callback and skips an applied replay", async () => {
    await writeFixture();
    fixture.onQuery = async (text) => {
      if (text === "SELECT 'backfill'") throw new Error("retryable database failure");
    };
    await expect(migrate()).rejects.toThrow(`Migration backfill ${sidecarName} failed`);
    fixture.onQuery = undefined;
    expect((await migrate()).applied).toHaveLength(1);
    fixture.queries.length = 0;
    const replay = await migrate();
    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toHaveLength(1);
    expect(fixture.queries.some((query) => query.text === "BEGIN")).toBe(false);
    expect(fixture.queries.some((query) => query.text === "SELECT 'backfill'")).toBe(false);
  });

  it.each(["callback", "import"])(
    "replaces %s errors with a content-free error and no source stack or cause",
    async (phase) => {
      const marker = "PRIVATE_HISTORICAL_VALUE_DO_NOT_LOG";
      const thrown = `throw new Error(${JSON.stringify(marker)});`;
      await writeFixture(
        phase === "callback" ? `export function backfill() { ${thrown} }` : thrown
      );
      const error = await migrate().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected migration failure");
      expect(error.message).toBe(`Migration backfill ${sidecarName} failed`);
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain(marker);
      expect(error.stack).not.toContain("data:text/javascript");
      expect(error.stack).not.toContain(Buffer.from(marker).toString("base64"));
    }
  );

  it("leaves bootstrap/grants execution SQL-only even when a sidecar is declared", async () => {
    await writeFixture("throw new Error('bootstrap must not import');");
    const query = vi.fn(async () => undefined);
    expect(await runSqlFilesWithClient({ query }, directory)).toEqual([sqlName]);
    expect(query.mock.calls).toEqual([["BEGIN"], [sql], ["COMMIT"]]);
  });

  it("keeps the external-module wire loader SQL-only and independent of sidecar bytes", async () => {
    const moduleSql = `${header}\nCREATE TABLE app.fixture (id uuid);`;
    await writeFixture("throw new Error('external wire loader must not import');", moduleSql);
    const expected = [
      {
        version: "0001",
        name: sqlName,
        sql: moduleSql,
        checksum: createHash("sha256").update(moduleSql).digest("hex")
      }
    ];
    expect(await loadModuleMigrationFiles(directory)).toEqual(expected);
    await rm(join(directory, sidecarName));
    expect(await loadModuleMigrationFiles(directory)).toEqual(expected);
  });

  it("does not import or execute a declared sidecar through the real external installer", async () => {
    const moduleSql = `${header}\nCREATE TABLE app.fixture (id uuid);`;
    await writeFixture("throw new Error('external installer must not import');", moduleSql);
    await expect(
      installModule({
        moduleId: "fixture",
        manifest: { database: { ownedTables: ["app.fixture"] } },
        bootstrapConnectionString: "postgresql://unused.invalid/synthetic",
        migrationConnectionString: "postgresql://unused.invalid/synthetic",
        migrationsDirectory: directory
      })
    ).resolves.toEqual({ installed: [sqlName] });
    expect(fixture.queries.some((query) => query.text === moduleSql)).toBe(true);
  });
});
