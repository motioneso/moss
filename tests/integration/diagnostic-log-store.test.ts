import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { DIAGNOSTIC_LOG_MAX_ROWS, purgeDiagnosticLog } from "@moss/settings";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #3978 slice 2B: the raw log store. Every check runs through the real runtime roles. The
// bootstrap client (a superuser) only seeds users and counts rows.

const adminA = "00000000-0000-4000-8000-000000003a01";
const adminB = "00000000-0000-4000-8000-000000003a02";
const demotedOwner = "00000000-0000-4000-8000-000000003a03";
const deactivatedAdmin = "00000000-0000-4000-8000-000000003a04";
const plainUser = "00000000-0000-4000-8000-000000003a05";
const deletableUser = "00000000-0000-4000-8000-000000003a06";

const SINCE = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

let appDb: Kysely<MossDatabase>;
let appContext: DataContextRunner;
let workerDb: Kysely<MossDatabase>;
let boot: pg.Client;

async function insertRecord(
  db: Kysely<MossDatabase>,
  opts: {
    owner?: string | null;
    message?: string;
    occurredAt?: Date;
    component?: string;
    level?: number;
  } = {}
): Promise<void> {
  await sql`
    INSERT INTO app.diagnostic_log_records
      (occurred_at, process, level, component, owner_user_id, message, context)
    VALUES (${(opts.occurredAt ?? new Date()).toISOString()}::timestamptz, 'worker',
            ${opts.level ?? 40}, ${opts.component ?? "connectors"}, ${opts.owner ?? null},
            ${opts.message ?? "msg"}, '{"k":"v"}'::jsonb)
  `.execute(db);
}

async function readAs(actor: string) {
  return appContext.withDataContext(
    { actorUserId: actor, requestId: `req:read-${actor}` },
    async (scopedDb) => {
      const result = await sql<{
        owned: boolean;
        owner_known: boolean;
        message: string | null;
        context: unknown;
      }>`
        SELECT owned, owner_known, message, context
        FROM app.read_diagnostic_log(${SINCE}::timestamptz, 40::smallint, NULL, NULL, 50)
      `.execute(scopedDb.db);
      return result.rows;
    }
  );
}

async function clearRecords(): Promise<void> {
  await boot.query("DELETE FROM app.diagnostic_log_records");
}

async function countRecords(): Promise<number> {
  const result = await boot.query("SELECT count(*)::int AS n FROM app.diagnostic_log_records");
  return result.rows[0].n as number;
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  boot = new Client({ connectionString: connectionStrings.bootstrap });
  await boot.connect();
  await boot.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status) VALUES
      ($1, 'log-a@example.test', 'Admin A', true, false, 'active'),
      ($2, 'log-b@example.test', 'Admin B', true, false, 'active'),
      ($3, 'log-demoted@example.test', 'Demoted Owner', false, true, 'active'),
      ($4, 'log-deact@example.test', 'Deactivated Admin', true, false, 'deactivated'),
      ($5, 'log-plain@example.test', 'Plain User', false, false, 'active'),
      ($6, 'log-del@example.test', 'Deletable', false, false, 'active')`,
    [adminA, adminB, demotedOwner, deactivatedAdmin, plainUser, deletableUser]
  );
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  appContext = new DataContextRunner(appDb);
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
});

afterAll(async () => {
  await appDb?.destroy();
  await workerDb?.destroy();
  await boot?.end();
});

describe("diagnostic log store roles", () => {
  it("lets the worker role insert a row", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: adminA });
    expect(await countRecords()).toBe(1);
  });

  it("refuses the app role any direct SELECT, DELETE or INSERT", async () => {
    await expect(sql`SELECT 1 FROM app.diagnostic_log_records`.execute(appDb)).rejects.toThrow(
      /permission denied/
    );
    await expect(sql`DELETE FROM app.diagnostic_log_records`.execute(appDb)).rejects.toThrow(
      /permission denied/
    );
    await expect(insertRecord(appDb, { owner: adminA })).rejects.toThrow(/permission denied/);
  });

  it("refuses the worker role direct SELECT or DELETE and the reader functions", async () => {
    await expect(sql`SELECT 1 FROM app.diagnostic_log_records`.execute(workerDb)).rejects.toThrow(
      /permission denied/
    );
    await expect(sql`DELETE FROM app.diagnostic_log_records`.execute(workerDb)).rejects.toThrow(
      /permission denied/
    );
    await expect(
      sql`SELECT * FROM app.read_diagnostic_log(now() - interval '1 day', 40::smallint, NULL, NULL, 5)`.execute(
        workerDb
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`SELECT * FROM app.diagnostic_log_coverage()`.execute(workerDb)
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses the app role the purge function", async () => {
    await expect(
      sql`SELECT app.purge_diagnostic_log(interval '7 days', 50000)`.execute(appDb)
    ).rejects.toThrow(/permission denied/);
  });
});

describe("diagnostic log reader privacy", () => {
  it("returns full text for the caller's own row and metadata only for another owner's", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: adminA, message: "A-PRIVATE-TEXT" });
    await insertRecord(workerDb, { owner: adminB, message: "B-PRIVATE-TEXT" });

    const rows = await readAs(adminA);
    const own = rows.find((r) => r.owned);
    const other = rows.find((r) => !r.owned);
    expect(own?.message).toBe("A-PRIVATE-TEXT");
    expect(own?.context).toEqual({ k: "v" });
    expect(other?.owner_known).toBe(true);
    expect(other?.message).toBeNull();
    expect(other?.context).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("B-PRIVATE-TEXT");
  });

  it("returns text but no context for an unowned row to an admin", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: null, message: "UNOWNED-TEXT" });
    const rows = await readAs(adminA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner_known).toBe(false);
    expect(rows[0]?.owned).toBe(false);
    expect(rows[0]?.message).toBe("UNOWNED-TEXT");
    expect(rows[0]?.context).toBeNull();
  });

  it("returns nothing to a non-admin, a deactivated admin and a demoted bootstrap owner", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: plainUser, message: "PLAIN-TEXT" });
    await insertRecord(workerDb, { owner: null, message: "PLATFORM-TEXT" });
    await insertRecord(workerDb, { owner: deactivatedAdmin, message: "DEACT-TEXT" });
    await insertRecord(workerDb, { owner: demotedOwner, message: "DEMOTED-TEXT" });
    expect(await readAs(plainUser)).toEqual([]);
    expect(await readAs(deactivatedAdmin)).toEqual([]);
    expect(await readAs(demotedOwner)).toEqual([]);
  });

  it("lets an active admin who is not the bootstrap owner read", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: adminA });
    expect(await readAs(adminA)).toHaveLength(1);
  });

  it("caps the reader at 50 rows", async () => {
    await clearRecords();
    for (let i = 0; i < 55; i += 1) {
      await insertRecord(workerDb, { owner: adminA, message: `m${i}` });
    }
    expect(await readAs(adminA)).toHaveLength(50);
  });

  it("reports coverage to an admin and an empty window to a non-admin", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: adminA });
    const cover = async (actor: string) =>
      appContext.withDataContext({ actorUserId: actor, requestId: "req:cover" }, async (s) => {
        const r = await sql<{
          oldest_at: Date | null;
          row_count: string;
        }>`SELECT oldest_at, row_count FROM app.diagnostic_log_coverage()`.execute(s.db);
        return r.rows[0];
      });
    const admin = await cover(adminA);
    expect(Number(admin?.row_count)).toBe(1);
    expect(admin?.oldest_at).not.toBeNull();
    const plain = await cover(plainUser);
    expect(Number(plain?.row_count)).toBe(0);
    expect(plain?.oldest_at).toBeNull();
  });
});

describe("diagnostic log table checks", () => {
  it("rejects an oversize message, a low level, and labels off the allow-list", async () => {
    await expect(insertRecord(workerDb, { message: "x".repeat(2049) })).rejects.toThrow(
      /check constraint/
    );
    await expect(insertRecord(workerDb, { level: 30 })).rejects.toThrow(/check constraint/);
    await expect(
      insertRecord(workerDb, { component: "mail-for-alice@example.test" })
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`INSERT INTO app.diagnostic_log_records
            (occurred_at, process, level, component, connection_kind, message)
          VALUES (now(), 'api', 40, 'api', 'alice-private-host', 'm')`.execute(workerDb)
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`INSERT INTO app.diagnostic_log_records
            (occurred_at, process, level, component, event_code, message)
          VALUES (now(), 'api', 40, 'api', 'free text code', 'm')`.execute(workerDb)
    ).rejects.toThrow(/check constraint/);
  });

  it("deletes a user's rows when the user is deleted", async () => {
    await clearRecords();
    await insertRecord(workerDb, { owner: deletableUser });
    await insertRecord(workerDb, { owner: adminA });
    await boot.query("DELETE FROM app.users WHERE id = $1", [deletableUser]);
    expect(await countRecords()).toBe(1);
  });
});

describe("diagnostic log row security and migration", () => {
  it("removes legacy unowned rows before exposing platform text and preserves owned rows", async () => {
    await clearRecords();
    await insertRecord(workerDb, { message: "LEGACY-UNOWNED-PRIVATE-MARKER" });
    await insertRecord(workerDb, { owner: adminA, message: "OWNED-A-MARKER" });
    await insertRecord(workerDb, { owner: adminB, message: "OWNED-B-MARKER" });
    expect(await countRecords()).toBe(3);
    const migration = readFileSync(
      "packages/settings/sql/0358_diagnostic_log_platform_text.sql",
      "utf8"
    );
    await boot.query("BEGIN");
    try {
      await boot.query(migration);
      const remaining = await boot.query(
        "SELECT owner_user_id, message FROM app.diagnostic_log_records ORDER BY message"
      );
      expect(remaining.rows).toEqual([
        { owner_user_id: adminA, message: "OWNED-A-MARKER" },
        { owner_user_id: adminB, message: "OWNED-B-MARKER" }
      ]);
    } finally {
      await boot.query("ROLLBACK");
    }
  });

  it("enables and forces row security, and hides rows from a role that holds SELECT", async () => {
    const flags = await boot.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'app.diagnostic_log_records'::regclass`
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    // With the table grant leaked, row security alone must still return no rows.
    await clearRecords();
    await insertRecord(workerDb, { owner: adminA });
    await boot.query("BEGIN");
    try {
      await boot.query("GRANT SELECT ON app.diagnostic_log_records TO jarvis_app_runtime");
      await boot.query("SET LOCAL ROLE jarvis_app_runtime");
      const visible = await boot.query("SELECT count(*)::int AS n FROM app.diagnostic_log_records");
      expect(visible.rows[0].n).toBe(0);
    } finally {
      await boot.query("ROLLBACK");
    }
  });

  it("re-applies cleanly and leaves policies, functions and grants unchanged", async () => {
    const snapshot = async () => {
      const policies = await boot.query(
        `SELECT policyname, cmd, roles::text AS roles FROM pg_policies
         WHERE tablename = 'diagnostic_log_records' ORDER BY policyname`
      );
      const functions = await boot.query(
        `SELECT proname, md5(prosrc) AS body, proacl::text AS acl FROM pg_proc
         WHERE proname IN ('read_diagnostic_log', 'diagnostic_log_coverage', 'purge_diagnostic_log')
         ORDER BY proname`
      );
      const table = await boot.query(
        "SELECT relacl::text AS acl FROM pg_class WHERE oid = 'app.diagnostic_log_records'::regclass"
      );
      return { policies: policies.rows, functions: functions.rows, table: table.rows };
    };
    const before = await snapshot();
    const migrations = [
      readFileSync("packages/settings/sql/0357_diagnostic_log_records.sql", "utf8"),
      readFileSync("packages/settings/sql/0358_diagnostic_log_platform_text.sql", "utf8")
    ];
    await boot.query("BEGIN");
    try {
      for (const migration of migrations) await boot.query(migration);
      for (const migration of migrations) await boot.query(migration);
      expect(await snapshot()).toEqual(before);
    } finally {
      await boot.query("ROLLBACK");
    }
  });
});

describe("diagnostic log purge", () => {
  it("removes rows past the age cap and keeps recent ones", async () => {
    await clearRecords();
    const day = 24 * 3600 * 1000;
    await insertRecord(workerDb, { occurredAt: new Date(Date.now() - 8 * day) });
    await insertRecord(workerDb, { occurredAt: new Date(Date.now() - 6 * day) });
    await insertRecord(workerDb, { occurredAt: new Date() });
    expect(await purgeDiagnosticLog(workerDb)).toBe(1);
    expect(await countRecords()).toBe(2);
  });

  it("trims to the row cap oldest first, with an exact count", async () => {
    await clearRecords();
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now() - (g * interval '1 second'), 'api', 40, 'api', 'g' || g
       FROM generate_series(1, $1::int) g`,
      [DIAGNOSTIC_LOG_MAX_ROWS + 1234]
    );
    expect(await purgeDiagnosticLog(workerDb)).toBe(1234);
    expect(await countRecords()).toBe(DIAGNOSTIC_LOG_MAX_ROWS);
    // The oldest rows (largest g) were the ones removed.
    const oldest = await boot.query(
      "SELECT min(message) AS m FROM app.diagnostic_log_records WHERE message = $1",
      [`g${DIAGNOSTIC_LOG_MAX_ROWS + 1234}`]
    );
    expect(oldest.rows[0].m).toBeNull();
    // A second run at exactly the cap deletes nothing.
    expect(await purgeDiagnosticLog(workerDb)).toBe(0);
  });
});
