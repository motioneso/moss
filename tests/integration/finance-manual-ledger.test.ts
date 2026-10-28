import { randomUUID } from "node:crypto";
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
import {
  sqlStore,
  type FinanceDb,
  type ManualAccountCreate,
  type ManualEntryCreate
} from "../../external-modules/finance/src/domain/index.js";
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
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => ({ rows: [...(await rpc.query(text, params)).rows] as never[] })
  };
  return sqlStore(port);
}
const account = (over: Partial<ManualAccountCreate> = {}): ManualAccountCreate => ({
  accountId: `manual:${randomUUID()}`,
  name: "Synthetic checking",
  type: "depository",
  subtype: "checking",
  isoCurrency: "USD",
  openingDate: "2026-10-01",
  openingBalanceCents: 100000,
  digest: "a".repeat(64),
  at: "2026-10-28T00:00:00Z",
  ...over
});
const entry = (accountId: string, over: Partial<ManualEntryCreate> = {}): ManualEntryCreate => ({
  id: `manual:${randomUUID()}`,
  accountId,
  name: "Synthetic purchase",
  date: "2026-10-02",
  amountCents: 8243,
  isoCurrency: "USD",
  categoryId: "groceries",
  notes: "Synthetic private note",
  cleared: false,
  digest: "b".repeat(64),
  at: "2026-10-28T00:00:00Z",
  ...over
});
const owner = <T>(
  fn: (s: ReturnType<typeof store>) => Promise<T>,
  actorUserId: string = ids.userA
) => runner.withDataContext({ actorUserId }, (scope) => fn(store(scope)));
beforeAll(async () => {
  await resetFoundationDatabase();
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
describe("manual ledger through installed module SQL and actual owner role", () => {
  it("creates one baseline without inventing income; replay preserves it", async () => {
    const a = account();
    expect(await owner((s) => s.manual!.createAccount(a))).toBe("created");
    expect(await owner((s) => s.manual!.createAccount(a))).toBe("unchanged");
    expect(await owner((s) => s.manual!.createAccount({ ...a, digest: "c".repeat(64) }))).toBe(
      "conflict"
    );
    expect(await owner((s) => s.getAccount(a.accountId))).toMatchObject({
      source: "manual",
      itemId: null,
      balanceCents: 100000,
      openingBalanceCents: 100000,
      openingDate: "2026-10-01"
    });
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toBeNull();
  });
  it("races identical and different entries without doubling or losing cents", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const spend = entry(a.accountId);
    const same = await Promise.all([
      owner((s) => s.manual!.createEntry(spend)),
      owner((s) => s.manual!.createEntry(spend))
    ]);
    expect(same.sort()).toEqual(["created", "unchanged"]);
    const refund = entry(a.accountId, { amountCents: -123, digest: "c".repeat(64) });
    const income = entry(a.accountId, { amountCents: -12000, digest: "d".repeat(64) });
    expect(
      await Promise.all([
        owner((s) => s.manual!.createEntry(refund)),
        owner((s) => s.manual!.createEntry(income))
      ])
    ).toEqual(["created", "created"]);
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(103880);
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toHaveLength(3);
    const events = await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 100));
    expect(events.filter((event) => event.params.accountId === a.accountId)).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("Synthetic private note");
  });
  it("keeps owner records unavailable and validates date/currency before balance movement", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    expect(await owner((s) => s.manual!.createEntry(entry(a.accountId)), ids.userB)).toBe(
      "unavailable"
    );
    expect(await owner((s) => s.getAccount(a.accountId), ids.userB)).toBeNull();
    expect(
      await owner((s) => s.manual!.createEntry(entry(a.accountId, { date: "2026-09-30" })))
    ).toBe("invalid_date");
    expect(
      await owner((s) => s.manual!.createEntry(entry(a.accountId, { isoCurrency: "EUR" })))
    ).toBe("unavailable");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(
      a.openingBalanceCents
    );
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toBeNull();
  });
  it("uses debt signs and refuses overflow without a transaction or activity", async () => {
    const debt = account({ type: "credit", subtype: "credit card" });
    await owner((s) => s.manual!.createAccount(debt));
    await owner((s) => s.manual!.createEntry(entry(debt.accountId)));
    expect((await owner((s) => s.getAccount(debt.accountId)))?.balanceCents).toBe(108243);
    const max = account({ openingBalanceCents: Number.MAX_SAFE_INTEGER });
    await owner((s) => s.manual!.createAccount(max));
    expect(
      await owner((s) => s.manual!.createEntry(entry(max.accountId, { amountCents: -1 })))
    ).toBe("overflow");
    expect(await owner((s) => s.getTransactionChunk(max.accountId, "2026-10"))).toBeNull();
    expect(
      (await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 100))).filter(
        (event) => event.params.accountId === max.accountId
      )
    ).toHaveLength(1);
  });
  it("preserves manual balances during stale sharing updates and provider upserts", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const stale = (await owner((s) => s.getAccount(a.accountId)))!;
    const e = entry(a.accountId);
    await owner((s) => s.manual!.createEntry(e));
    await owner((s) => s.putAccount({ ...stale, sharedToHousehold: true }));
    await owner((s) =>
      s.putAccount({ ...stale, source: undefined, itemId: "synthetic-provider", balanceCents: 2 })
    );
    const persisted = (await owner((s) => s.getAccount(a.accountId)))!;
    expect(persisted).toMatchObject({
      source: "manual",
      itemId: null,
      balanceCents: 91757,
      sharedToHousehold: true
    });
    const tx = (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))![0]!;
    await owner((s) => s.putTransaction({ ...tx, source: undefined, amountCents: 999999 }));
    await owner((s) => s.putTransactionChunk(a.accountId, "2026-10", []));
    expect(
      (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))![0]!.amountCents
    ).toBe(8243);
  });
});
