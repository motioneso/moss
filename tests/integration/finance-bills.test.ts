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
import { sqlStore, type FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import type { BillPlan } from "../../external-modules/finance/src/domain/bills.js";
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
const at = "2026-10-29T00:00:00Z";
const plan: BillPlan = {
  id: randomUUID(),
  name: "Synthetic utility bill",
  accountId: "manual:bills",
  categoryId: "utilities",
  isoCurrency: "USD",
  amountCents: 10001,
  anchorDate: "2026-10-31",
  cadence: "monthly"
};
const review = () => owner((s) => s.budgetPolicy!.get()).then((r) => r!);
beforeAll(async () => {
  for (const user of [ids.userA, ids.userB])
    await owner(async (s) => {
      await s.manual!.createAccount({
        accountId: "manual:bills",
        name: "Synthetic bill cash",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-10-01",
        openingBalanceCents: 100000,
        digest: "a".repeat(64),
        at
      });
      await s.budgetPolicy!.configure("USD", false, at);
    }, user);
  await owner((s) =>
    s.manual!.createEntry({
      id: "manual:bill-payment",
      accountId: "manual:bills",
      name: "Synthetic utility actual",
      date: "2026-10-30",
      amountCents: 10099,
      isoCurrency: "USD",
      categoryId: "utilities",
      notes: "",
      cleared: true,
      digest: "b".repeat(64),
      at
    })
  );
});
describe("installed owner-scoped bill plans and occurrence reviews", () => {
  it("creates one projected plan without changing any account or ledger amount", async () => {
    const before = await owner((s) => s.getAccount(plan.accountId));
    const e = await review();
    expect(await owner((s) => s.bills!.create(plan, e, at))).toBe(true);
    expect(await owner((s) => s.getAccount(plan.accountId))).toEqual(before);
    expect(await owner((s) => s.getLedger("2026-10"))).toBeNull();
    expect(await owner((s) => s.bills!.create(plan, e, at))).toBe(false);
  });
  it("confines plan reads to their owner", async () => {
    expect(await owner((s) => s.bills!.plans(), ids.userB)).toEqual([]);
  });
  it("matches actual posted amounts once without editing the underlying transaction", async () => {
    const before = await owner((s) => s.getTransactionChunk(plan.accountId, "2026-10"));
    expect(
      await owner(async (s) =>
        s.bills!.decide(
          {
            planId: plan.id,
            dueDate: "2026-10-31",
            state: "matched",
            transactionId: "manual:bill-payment"
          },
          await review(),
          at
        )
      )
    ).toBe(true);
    expect(await owner((s) => s.getTransactionChunk(plan.accountId, "2026-10"))).toEqual(before);
    expect((await owner((s) => s.bills!.decisions("2026-10-01", "2026-10-31")))[0]).toMatchObject({
      actualCents: 10099,
      matchedValid: true
    });
  });
  it("confines occurrence review reads to their owner", async () => {
    expect(await owner((s) => s.bills!.decisions("2026-10-01", "2026-10-31"), ids.userB)).toEqual(
      []
    );
  });
  it("rejects duplicate transaction use, stale reviews and mismatched accounts", async () => {
    const second = { ...plan, id: randomUUID() };
    expect(await owner(async (s) => s.bills!.create(second, await review(), at))).toBe(true);
    const e = await review();
    expect(
      await owner((s) =>
        s.bills!.decide(
          {
            planId: second.id,
            dueDate: "2026-10-31",
            state: "matched",
            transactionId: "manual:bill-payment"
          },
          e,
          at
        )
      )
    ).toBe(false);
    expect((await review()).revision).toBe(e.revision);
    expect(
      await owner((s) =>
        s.bills!.create({ ...second, id: randomUUID(), isoCurrency: "EUR" }, e, at)
      )
    ).toBe(false);
    expect(
      await owner((s) =>
        s.bills!.create({ ...second, id: randomUUID(), accountId: "foreign" }, e, at)
      )
    ).toBe(false);
    expect(
      await owner((s) =>
        s.bills!.create({ ...second, id: randomUUID(), categoryId: "income" }, e, at)
      )
    ).toBe(false);
  });
  it("undoes reviews without ledger changes and preserves reviews when stopping a series", async () => {
    let e = await review();
    expect(await owner((s) => s.bills!.stop(plan.id, "2026-10-01", e, at))).toBe(false);
    expect(await owner((s) => s.bills!.clear(plan.id, "2026-10-31", e, at))).toBe(true);
    expect(await owner((s) => s.bills!.clear(plan.id, "2026-10-31", e, at))).toBe(false);
    e = await review();
    expect(
      await owner((s) =>
        s.bills!.decide(
          { planId: plan.id, dueDate: "2026-10-31", state: "skipped", transactionId: null },
          e,
          at
        )
      )
    ).toBe(true);
    e = await review();
    expect(await owner((s) => s.bills!.stop(plan.id, "2026-10-31", e, at))).toBe(true);
    expect((await owner((s) => s.bills!.plans())).find((p) => p.id === plan.id)?.endDate).toBe(
      "2026-10-31"
    );
    expect(await owner((s) => s.bills!.decisions("2026-10-01", "2026-10-31"))).toHaveLength(1);
  });
  it("serializes competing bill decisions on one review", async () => {
    const id = (await owner((s) => s.bills!.plans())).find((p) => p.id !== plan.id)!.id;
    const e = await review();
    const d = { planId: id, dueDate: "2026-11-30", state: "skipped" as const, transactionId: null };
    expect(
      (
        await Promise.all([
          owner((s) => s.bills!.decide(d, e, at)),
          owner((s) => s.bills!.decide(d, e, at))
        ])
      ).sort()
    ).toEqual([false, true]);
  });
  it("rejects foreign and pending matches without consuming the budget revision", async () => {
    await owner(
      (s) =>
        s.manual!.createEntry({
          id: "manual:foreign-bill",
          accountId: plan.accountId,
          name: "Synthetic foreign bill",
          date: "2026-10-30",
          amountCents: 100,
          isoCurrency: "USD",
          categoryId: "utilities",
          notes: "",
          cleared: true,
          digest: "c".repeat(64),
          at
        }),
      ids.userB
    );
    const active = (await owner((s) => s.bills!.plans())).find((p) => p.id !== plan.id)!;
    let e = await review();
    expect(
      await owner((s) =>
        s.bills!.decide(
          {
            planId: active.id,
            dueDate: "2026-12-31",
            state: "matched",
            transactionId: "manual:foreign-bill"
          },
          e,
          at
        )
      )
    ).toBe(false);
    expect((await review()).revision).toBe(e.revision);
    const tx = (await owner((s) => s.getTransactionChunk(plan.accountId, "2026-10")))![0]!;
    await owner((s) =>
      s.putTransaction({ ...tx, id: "synthetic-pending", source: "provider", pending: true })
    );
    e = await review();
    expect(
      await owner((s) =>
        s.bills!.decide(
          {
            planId: active.id,
            dueDate: "2026-12-31",
            state: "matched",
            transactionId: "synthetic-pending"
          },
          e,
          at
        )
      )
    ).toBe(false);
    expect((await review()).revision).toBe(e.revision);
  });
});
