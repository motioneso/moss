import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  DataContextRunner,
  createModuleStorageRpc,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import { installModule } from "../../scripts/module-install.js";
import { sqlStore, type FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import {
  connectionStrings,
  ids,
  resetFoundationDatabase,
  grantModuleMembershipAtSetup,
  revokeModuleMembershipAtTeardown,
  dropModuleRolesAtTeardown
} from "./test-database.js";
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let ownedTables: string[];
let setupReady = false;
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => ({ rows: [...(await rpc.query(text, params)).rows] as never[] })
  };
  return sqlStore(port);
}
const owner = <T>(
  fn: (s: ReturnType<typeof store>) => Promise<T>,
  actorUserId: string = ids.userA
) => runner.withDataContext({ actorUserId }, (scope) => fn(store(scope)));
beforeAll(async () => {
  await resetFoundationDatabase();
  setupReady = true;
  const manifest = JSON.parse(
    await readFile("external-modules/finance/jarvis.module.json", "utf8")
  );
  ownedTables = manifest.database.ownedTables;
  await installModule({
    moduleId: "finance",
    manifest,
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/finance/sql"
  });
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  runner = new DataContextRunner(db);
});
afterAll(async () => {
  if (!setupReady) return;
  await db?.destroy();
  await revokeModuleMembershipAtTeardown([`REVOKE ${runtimeRole} FROM jarvis_app_runtime`]);
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    for (const table of ownedTables ?? [])
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${runtimeRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${runtimeRole}`
    );
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${installRole} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${installRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${installRole} CASCADE`
    );
    await dropModuleRolesAtTeardown([installRole, runtimeRole]);
    await client.query("DELETE FROM app.module_installs WHERE module_id = 'finance'");
    await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = 'finance'");
  } finally {
    await client.end();
  }
});

import { historyExportHandler } from "../../external-modules/finance/src/worker/handlers/history-export.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const query = (text: string, params: unknown[] = [], user: string = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
const prepare = (input: Record<string, unknown> = {}, user: string = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    historyExportHandler({
      store: async () => store(scope),
      now: () => new Date("2026-10-30T00:00:00Z")
    } as unknown as WorkerPorts)({ actorUserId: user, ...input })
  );
const seed = (first: number, last: number, user: string = ids.userA) =>
  query(
    `INSERT INTO app.finance_transactions(owner_user_id,id,account_id,date,amount_cents,iso_currency,name,category_id,pending,notes)
   SELECT app.current_actor_user_id(),'history:'||n,'history:many','2024-02-29'::date+(n%365),n,'USD','Synthetic history '||n,'groceries',false,'DO_NOT_EXPORT_SYNTHETIC_NOTE'
   FROM generate_series($1::integer,$2::integer) AS n`,
    [first, last],
    user
  );
beforeAll(async () => {
  await owner((s) => s.budgetPolicy!.configure("USD", false, "2026-10-30T00:00:00Z"));
});
describe("installed owned-history snapshot export", () => {
  it("exports across stored months beyond the loaded-register limit, with private owner rows omitted", async () => {
    await seed(1, 2501);
    await seed(1, 1, ids.userB);
    const result = await prepare();
    expect(result).toMatchObject({ status: "ready", totalCount: 2501 });
    expect(String(result.csv).split("\r\n")).toHaveLength(2503);
    expect(result.csv).not.toContain("DO_NOT_EXPORT_SYNTHETIC_NOTE");
    expect(await prepare({}, ids.userB)).toMatchObject({ status: "ready", totalCount: 1 });
  });
  it("accepts exactly 5,000 and refuses 5,001 without returning a partial CSV", async () => {
    await seed(2502, 5000);
    expect(await prepare({ accountId: "history:many" })).toMatchObject({
      status: "ready",
      totalCount: 5000
    });
    await seed(5001, 5001);
    expect(await prepare({ accountId: "history:many" })).toEqual({
      status: "too_many",
      totalCount: 5001,
      maxRows: 5000
    });
    const projection = await owner((s) => s.historyExport!.read({ accountId: "history:many" }));
    expect(projection).toEqual({ totalCount: 5001, rows: [] });
  });
  it("uses inclusive calendar/account boundaries, including a leap day and empty ranges", async () => {
    const onDay = await query(
      "SELECT count(*)::integer AS n FROM app.finance_transactions WHERE date='2024-02-29'"
    );
    const expected = Number(onDay.rows[0]!.n);
    const result = await prepare({
      from: "2024-02-29",
      through: "2024-02-29",
      accountId: "history:many"
    });
    expect(result).toMatchObject({ status: "ready", totalCount: expected });
    expect(String(result.csv)).toContain('"2024-02-29"');
    const empty = await prepare({ from: "1900-01-01", through: "1900-01-02" });
    expect(empty).toMatchObject({ status: "ready", totalCount: 0 });
    expect(String(empty.csv).split("\r\n")).toHaveLength(2);
    await expect(prepare({ from: "2026-02-30" })).rejects.toThrow();
  });
  it("keeps parent/split/currency/posting metadata and formula-safe archived and orphan account names", async () => {
    await owner((s) =>
      s.manual!.createAccount({
        accountId: "history:special",
        name: "=Synthetic cash",
        type: "depository",
        subtype: "checking",
        isoCurrency: "EUR",
        openingDate: "2026-10-01",
        openingBalanceCents: 10000,
        digest: "a".repeat(64),
        at: "2026-10-30T00:00:00Z"
      })
    );
    await owner((s) =>
      s.manual!.createEntry({
        id: "history:special:entry",
        accountId: "history:special",
        name: '=Synthetic "merchant"',
        date: "2026-10-02",
        amountCents: 1501,
        isoCurrency: "EUR",
        categoryId: "groceries",
        notes: "DO_NOT_EXPORT_SYNTHETIC_NOTE",
        cleared: true,
        digest: "b".repeat(64),
        at: "2026-10-30T00:00:00Z"
      })
    );
    await query(
      "UPDATE app.finance_accounts SET archived_at='2026-10-29T00:00:00Z' WHERE account_id=$1",
      ["history:special"]
    );
    await query(
      "UPDATE app.finance_transactions SET reconciled_at='2026-10-29T00:00:00Z',splits=$2::jsonb WHERE id=$1",
      [
        "history:special:entry",
        JSON.stringify([
          { categoryId: "groceries", amountCents: 1601 },
          { categoryId: "income", amountCents: -100 }
        ])
      ]
    );
    const result = await prepare({ accountId: "history:special" });
    expect(result).toMatchObject({ status: "ready", totalCount: 1 });
    expect(result.csv).toContain('"\'=Synthetic cash"');
    expect(result.csv).toContain('"\'=Synthetic ""merchant"""');
    expect(result.csv).toContain(',15.01,,"EUR","Posted","Yes","2026-10-29');
    expect(result.csv).toContain('"Balanced"');
    expect(result.csv).not.toContain("DO_NOT_EXPORT_SYNTHETIC_NOTE");
    await query(`INSERT INTO app.finance_transactions(owner_user_id,id,account_id,date,amount_cents,iso_currency,name,pending)
      VALUES(app.current_actor_user_id(),'history:pending','history:orphan','2026-10-29',-301,'GBP','Synthetic pending refund',true)`);
    const orphan = await prepare({ accountId: "history:orphan" });
    expect(orphan).toMatchObject({ status: "ready", totalCount: 1 });
    expect(orphan.csv).toContain('"history:orphan"');
    expect(orphan.csv).toContain(',,3.01,"GBP","Pending","Not tracked"');
  });
});
