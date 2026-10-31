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
import { reportsNetWorthHandler } from "../../external-modules/finance/src/worker/handlers/reports.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const at = "2026-10-30T00:00:00Z";
const createAccount = (id: string, currency: string, extra: Record<string, unknown> = {}) =>
  owner((s) =>
    s.manual!.createAccount({
      accountId: id,
      name: "Synthetic ledger account",
      type: "depository",
      subtype: "checking",
      isoCurrency: currency,
      openingDate: "2026-10-01",
      openingBalanceCents: 10000,
      digest: "a".repeat(64),
      at,
      ...extra
    })
  );
const entry = (
  id: string,
  date: string,
  amountCents: number,
  currency: string,
  extra: Record<string, unknown> = {}
) =>
  owner((s) =>
    s.manual!.createEntry({
      id: `${id}:${date}:${amountCents}`,
      accountId: id,
      name: "Synthetic private purchase",
      date,
      amountCents,
      isoCurrency: currency,
      categoryId: "groceries",
      notes: "Synthetic private note",
      cleared: false,
      digest: "b".repeat(64),
      at,
      ...extra
    })
  );
const movements = (through = "2026-10-30", user: string = ids.userA) =>
  owner((s) => s.manual!.netWorthMovements!(through), user);
const report = (currency: string, user: string = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    reportsNetWorthHandler({
      store: async () => store(scope),
      now: () => new Date(at),
      localTimezone: "UTC",
      mirror: {
        list: () => {
          throw new Error("Net worth must not read shared data");
        }
      }
    } as unknown as WorkerPorts)({ actorUserId: user, currency, months: 6 })
  );
const change = (text: string, params: unknown[]) =>
  runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
beforeAll(async () => {
  await owner((s) => s.budgetPolicy!.configure("USD", false, at));
});
describe("net worth from installed manual ledger SQL", () => {
  it("projects exact daily posted movements without transaction names or notes", async () => {
    await createAccount("worth:eur", "EUR", { openingDate: "2025-12-31" });
    await entry("worth:eur", "2026-01-01", 100, "EUR");
    await entry("worth:eur", "2026-10-01", 1251, "EUR");
    await entry("worth:eur", "2026-10-05", -301, "EUR");
    const rows = (await movements()).filter((r) => r.accountId === "worth:eur");
    expect(rows).toEqual([
      { accountId: "worth:eur", date: "2026-01-01", amountCents: "100", valid: true },
      { accountId: "worth:eur", date: "2026-10-01", amountCents: "1251", valid: true },
      { accountId: "worth:eur", date: "2026-10-05", amountCents: "-301", valid: true }
    ]);
    expect(JSON.stringify(rows)).not.toContain("private");
    expect((await movements("2026-10-01")).filter((r) => r.accountId === "worth:eur")).toHaveLength(
      2
    );
    const result = await report("EUR");
    expect(result).toMatchObject({ headlineCents: 8950, asOf: "2026-10-30" });
    expect((result.points as { date: string; totalCents: number }[])[0]).toEqual({
      date: "2026-05-01",
      totalCents: 9900
    });
  });
  it("ignores future ledger rows, rejects pending manual entries and retains a real zero baseline", async () => {
    await createAccount("worth:gbp", "GBP", { openingBalanceCents: 1000 });
    await entry("worth:gbp", "2026-11-01", 200, "GBP");
    await entry("worth:gbp", "2026-10-10", 50, "GBP");
    await expect(
      change("UPDATE app.finance_transactions SET pending=true WHERE id=$1", [
        "worth:gbp:2026-10-10:50"
      ])
    ).rejects.toThrow("finance_transactions_manual_entry");
    expect((await movements()).filter((r) => r.accountId === "worth:gbp")).toEqual([
      { accountId: "worth:gbp", date: "2026-10-10", amountCents: "50", valid: true }
    ]);
    expect(await report("GBP")).toMatchObject({ headlineCents: 950 });
    await createAccount("worth:zero", "AUD", { openingBalanceCents: 0 });
    expect(await report("AUD")).toMatchObject({ headlineCents: 0 });
  });
  it("keeps reconciliation and category metadata out of ledger net worth and discloses missing provider snapshots", async () => {
    await createAccount("worth:cad", "CAD");
    await entry("worth:cad", "2026-10-15", 2000, "CAD");
    const statement = (await owner((s) => s.reconciliation!.read("worth:cad", "2026-10-15")))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "worth:cad-statement",
          accountId: "worth:cad",
          statementDate: "2026-10-15",
          balanceCents: 8000,
          isoCurrency: "CAD",
          expectedRevision: statement.revision,
          selectedIds: ["worth:cad:2026-10-15:2000"],
          digest: "c".repeat(64),
          at
        })
      )
    ).toBe("created");
    const before = await report("CAD");
    expect(before).toMatchObject({ headlineCents: 8000 });
    const row = (await owner((s) => s.bulk!.monthRows("2026-10"))).find(
      (r) => r.id === "worth:cad:2026-10-15:2000"
    )!;
    expect(await owner((s) => s.bulk!.categorize([row], "dining"))).toBe(true);
    expect(await report("CAD")).toEqual(before);
    await owner((s) =>
      s.putAccount({
        accountId: "worth:provider",
        itemId: null,
        name: "Synthetic unvalued bank",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: null,
        balanceCents: 999999,
        isoCurrency: "CAD",
        updatedAt: at
      })
    );
    const after = await report("CAD");
    expect(after).toMatchObject({ headlineCents: 8000 });
    expect(after.coverage).toContainEqual(
      expect.objectContaining({
        accountId: "worth:provider",
        included: false,
        reason: "no_snapshot"
      })
    );
  });
  it("applies actual asset/debt signs and conserves value across opposing manual entries", async () => {
    await createAccount("worth:asset", "NZD", {
      type: "other",
      subtype: "asset",
      openingBalanceCents: 100000
    });
    await createAccount("worth:debt", "NZD", {
      type: "credit",
      subtype: "credit card",
      openingBalanceCents: 5000
    });
    await entry("worth:asset", "2026-10-10", 3000, "NZD");
    await entry("worth:debt", "2026-10-10", 2000, "NZD");
    await entry("worth:debt", "2026-10-11", -500, "NZD");
    expect(await report("NZD")).toMatchObject({ headlineCents: 90500 });
    await entry("worth:asset", "2026-10-12", 1000, "NZD");
    await entry("worth:debt", "2026-10-12", -1000, "NZD");
    expect(await report("NZD")).toMatchObject({ headlineCents: 90500 });
  });
  it("marks incompatible source rows invalid rather than hiding their effect", async () => {
    await createAccount("worth:invalid", "CHF");
    await entry("worth:invalid", "2026-10-10", 100, "CHF");
    const id = "worth:invalid:2026-10-10:100";
    await expect(
      change("UPDATE app.finance_transactions SET amount_cents=$2 WHERE id=$1", [
        id,
        "9007199254740992"
      ])
    ).rejects.toThrow("finance_transactions_manual_entry");
    for (const [text, params] of [
      ["UPDATE app.finance_transactions SET iso_currency=$2 WHERE id=$1", [id, "EUR"]],
      [
        "UPDATE app.finance_transactions SET iso_currency='CHF',amount_cents=100,date=$2::date WHERE id=$1",
        [id, "2026-09-30"]
      ]
    ] as const) {
      await change(text, [...params]);
      expect((await movements()).find((r) => r.accountId === "worth:invalid")?.valid).toBe(false);
      expect(await report("CHF")).toMatchObject({
        headlineCents: null,
        unavailableReason: "invalid_history"
      });
    }
  });
  it("keeps same-id account movements private to their owner", async () => {
    for (const user of [ids.userA, ids.userB])
      await owner(async (s) => {
        await s.manual!.createAccount({
          accountId: "worth:private",
          name: "Synthetic private ledger",
          type: "depository",
          subtype: "checking",
          isoCurrency: "USD",
          openingDate: "2026-10-01",
          openingBalanceCents: 10000,
          digest: "a".repeat(64),
          at
        });
        await s.manual!.createEntry({
          id: "worth:private:entry",
          accountId: "worth:private",
          name: "Synthetic owned expense",
          date: "2026-10-15",
          amountCents: user === ids.userA ? 1000 : 4000,
          isoCurrency: "USD",
          categoryId: "groceries",
          notes: "Synthetic owner note",
          cleared: true,
          digest: "d".repeat(64),
          at
        });
      }, user);
    expect((await movements()).find((r) => r.accountId === "worth:private")?.amountCents).toBe(
      "1000"
    );
    expect(
      (await movements("2026-10-30", ids.userB)).find((r) => r.accountId === "worth:private")
        ?.amountCents
    ).toBe("4000");
    expect(await report("USD")).toMatchObject({ headlineCents: 9000 });
    expect(await report("USD", ids.userB)).toMatchObject({ headlineCents: 6000 });
  });
  it("projects more than 5,000 daily history dates without raising platform read caps", async () => {
    await createAccount("worth:long-history", "HKD", {
      openingDate: "2000-01-01",
      openingBalanceCents: 100000
    });
    await change(
      `WITH inserted AS (
      INSERT INTO app.finance_transactions(owner_user_id,id,account_id,date,amount_cents,iso_currency,name,category_id,pending,source,entry_digest,cleared)
      SELECT app.current_actor_user_id(),'worth:long:'||n,'worth:long-history','2000-01-01'::date+n,1,'HKD','Synthetic historical movement','groceries',false,'manual',$1::text,false
      FROM generate_series(0,6000) AS n RETURNING amount_cents
    ) UPDATE app.finance_accounts SET balance_cents=opening_balance_cents-(SELECT sum(amount_cents) FROM inserted),ledger_revision=ledger_revision+1
      WHERE account_id='worth:long-history'`,
      ["e".repeat(64)]
    );
    const rows = (await movements()).filter((r) => r.accountId === "worth:long-history");
    expect(rows).toHaveLength(6001);
    expect(rows[0]).toEqual({
      accountId: "worth:long-history",
      date: "2000-01-01",
      amountCents: "1",
      valid: true
    });
    expect(rows[59]?.date).toBe("2000-02-29");
    const result = await report("HKD");
    expect(result).toMatchObject({ headlineCents: 93999, asOf: "2026-10-30" });
    expect(result.points as unknown[]).toEqual([
      { date: "2026-05-01", totalCents: 93999 },
      { date: "2026-10-30", totalCents: 93999 }
    ]);
  });
  it("keeps an odd daily sum above JS precision exact through the monthly JSON projection", async () => {
    const large = Number.MAX_SAFE_INTEGER;
    await createAccount("worth:precision", "CNY", { openingBalanceCents: large });
    await entry("worth:precision", "2026-10-15", large, "CNY");
    await entry("worth:precision", "2026-10-15", large - 1, "CNY");
    expect((await movements()).find((r) => r.accountId === "worth:precision")).toEqual({
      accountId: "worth:precision",
      date: "2026-10-15",
      amountCents: "18014398509481981",
      valid: true
    });
    expect(await report("CNY")).toMatchObject({ headlineCents: -(large - 1) });
  });
});
