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
import {
  billEntryPreviewHandler,
  billEntryRecordHandler
} from "../../external-modules/finance/src/worker/handlers/bill-entry.js";
import type { ToolFactory } from "../../external-modules/finance/src/worker/registry.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { BillEntryCreate } from "../../external-modules/finance/src/domain/bill-entry.js";
const at = "2026-10-30T12:00:00Z";
const run = (factory: ToolFactory, input: Record<string, unknown>, user: string = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    factory({
      store: async () => store(scope),
      now: () => new Date(at),
      localTimezone: "UTC",
      kv: { get: async () => null }
    } as unknown as WorkerPorts)(input)
  );
const review = (user: string = ids.userA) =>
  owner((s) => s.budgetPolicy!.get(), user).then((r) => r!);
beforeAll(async () => {
  for (const user of [ids.userA, ids.userB, ids.adminUser])
    await owner((s) => s.budgetPolicy!.configure("USD", false, at), user);
  if (process.env.MOSS_FINANCE_BILL_ENTRY_RLS_NEGATIVE === "1") {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      for (const table of ["finance_transactions", "finance_bill_occurrences"])
        await client.query(`ALTER TABLE app.${table} DISABLE ROW LEVEL SECURITY`);
    } finally {
      await client.end();
    }
  }
});
async function fresh(type = "depository", balance = 100000) {
  const accountId = `manual:${randomUUID()}`,
    planId = randomUUID(),
    operationId = randomUUID();
  const plan: BillPlan = {
    id: planId,
    accountId,
    name: "Synthetic due bill",
    categoryId: "utilities",
    isoCurrency: "USD",
    amountCents: 1234,
    anchorDate: "2026-10-15",
    cadence: "monthly"
  };
  await owner(async (s) => {
    expect(
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic cash",
        type,
        subtype: type === "credit" ? "credit card" : "checking",
        isoCurrency: "USD",
        openingDate: "2026-09-01",
        openingBalanceCents: balance,
        digest: "a".repeat(64),
        at
      })
    ).toBe("created");
    expect(await s.bills!.create(plan, (await s.budgetPolicy!.get())!, at)).toBe(true);
  });
  const e = await review();
  const input = {
    operationId,
    planId,
    accountId,
    name: plan.name,
    categoryId: plan.categoryId,
    isoCurrency: "USD",
    dueDate: plan.anchorDate,
    date: plan.anchorDate,
    amountCents: 1234,
    cleared: true,
    expectedRevision: e.revision,
    expectedFingerprint: e.fingerprint
  };
  const entry: BillEntryCreate = {
    id: `manual:${operationId}`,
    accountId,
    date: plan.anchorDate,
    name: plan.name,
    categoryId: plan.categoryId,
    isoCurrency: "USD",
    amountCents: 1234,
    cleared: true,
    notes: "",
    digest: "b".repeat(64),
    at,
    today: "2026-10-30",
    planId,
    dueDate: plan.anchorDate,
    review: e
  };
  return { input, entry, plan };
}
const snapshot = (e: BillEntryCreate) =>
  owner(async (s) => ({
    account: await s.getAccount(e.accountId),
    entries: await s.getTransactionChunk(e.accountId, "2026-10"),
    decisions: (await s.bills!.decisions("2026-10-01", "2026-10-31")).filter(
      (d) => d.planId === e.planId
    ),
    revision: (await s.budgetPolicy!.get())!.revision,
    activity: (await s.listActivity("2026-10-01T00:00:00Z", "2100-01-01", 1000)).filter(
      (a) => a.kind === "bill.record-entry" && a.params.planId === e.planId
    )
  }));
describe("atomic reviewed bill entry recording", () => {
  it("previews without mutation, then creates one balanced expense and match with metadata activity", async () => {
    const f = await fresh(),
      before = await snapshot(f.entry);
    expect(await run(billEntryPreviewHandler, f.input)).toMatchObject({
      status: "ok",
      canRecord: true,
      beforeCents: 100000,
      afterCents: 98766,
      expectedCents: 1234
    });
    expect(await snapshot(f.entry)).toEqual(before);
    expect(await run(billEntryRecordHandler, f.input)).toMatchObject({
      status: "ok",
      unchanged: false
    });
    const after = await snapshot(f.entry);
    expect(after.account).toMatchObject({ balanceCents: 98766, ledgerRevision: 1 });
    expect(after.entries).toHaveLength(1);
    expect(after.entries![0]).toMatchObject({
      id: f.entry.id,
      amountCents: 1234,
      categoryId: "utilities",
      cleared: true,
      pending: false,
      source: "manual"
    });
    expect(after.decisions).toEqual([
      expect.objectContaining({
        state: "matched",
        transactionId: f.entry.id,
        actualCents: 1234,
        matchedValid: true
      })
    ]);
    expect(after.activity).toHaveLength(1);
    expect(after.revision).toBe(before.revision + 1);
  });
  it("replays exactly with stale tokens, conflicts on changed intent and refuses repairing an undone match", async () => {
    const f = await fresh();
    await run(billEntryRecordHandler, f.input);
    const saved = await snapshot(f.entry);
    expect(await run(billEntryRecordHandler, f.input)).toMatchObject({
      status: "ok",
      unchanged: true
    });
    await expect(run(billEntryRecordHandler, { ...f.input, amountCents: 1235 })).rejects.toThrow();
    expect(await snapshot(f.entry)).toEqual(saved);
    await owner(async (s) =>
      expect(
        await s.bills!.clear(f.plan.id, f.plan.anchorDate, (await s.budgetPolicy!.get())!, at)
      ).toBe(true)
    );
    await expect(run(billEntryRecordHandler, f.input)).rejects.toThrow();
    expect((await snapshot(f.entry)).entries).toEqual(saved.entries);
    expect((await snapshot(f.entry)).account).toEqual(saved.account);
  });
  it("serializes competing identities to one movement, match, activity and revision", async () => {
    const f = await fresh(),
      before = await snapshot(f.entry);
    const results = await Promise.all(
      [f.entry, { ...f.entry, id: `manual:${randomUUID()}` }].map((e) =>
        owner((s) => s.bills!.recordEntry!(e))
      )
    );
    expect(results.sort()).toEqual([false, true]);
    const after = await snapshot(f.entry);
    expect(after.entries).toHaveLength(1);
    expect(after.decisions).toHaveLength(1);
    expect(after.account?.balanceCents).toBe(98766);
    expect(after.activity).toHaveLength(1);
    expect(after.revision).toBe(before.revision + 1);
  });
  it("rejects a stale ledger snapshot with no partial account, entry, match or activity", async () => {
    const f = await fresh();
    await owner((s) =>
      s.manual!.createEntry({ ...f.entry, id: `manual:${randomUUID()}`, amountCents: 99 })
    );
    const changed = await snapshot(f.entry);
    expect(await owner((s) => s.bills!.recordEntry!(f.entry))).toBe(false);
    expect(await snapshot(f.entry)).toEqual(changed);
  });
  it("blocks exact-amount nearby expenses in preview, handler and SQL, including adjacent months", async () => {
    const f = await fresh();
    f.entry.date = "2026-10-01";
    f.input.date = f.entry.date;
    await owner((s) =>
      s.manual!.createEntry({ ...f.entry, id: `manual:${randomUUID()}`, date: "2026-09-30" })
    );
    const e = await review();
    f.entry.review = e;
    f.input.expectedRevision = e.revision;
    f.input.expectedFingerprint = e.fingerprint;
    const before = await snapshot(f.entry);
    expect(await run(billEntryPreviewHandler, f.input)).toMatchObject({
      canRecord: false,
      candidateCount: 1
    });
    await expect(run(billEntryRecordHandler, f.input)).rejects.toThrow();
    expect(await owner((s) => s.bills!.recordEntry!(f.entry))).toBe(false);
    expect(await snapshot(f.entry)).toEqual(before);
  });
  it.each([
    "before-opening",
    "future",
    "non-occurrence",
    "future-occurrence",
    "closed",
    "statement",
    "overflow"
  ])("refuses %s without partial writes", async (mode) => {
    const f = await fresh("depository", mode === "overflow" ? -Number.MAX_SAFE_INTEGER : 100000);
    if (mode === "before-opening") f.entry.date = "2026-08-31";
    if (mode === "future") f.entry.date = "2026-10-31";
    if (mode === "non-occurrence") f.entry.dueDate = "2026-10-16";
    if (mode === "future-occurrence") f.entry.dueDate = "2026-11-15";
    if (mode === "closed" || mode === "statement") {
      await runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
        await createModuleStorageRpc(scope, "finance").query(
          mode === "closed"
            ? "UPDATE app.finance_accounts SET archived_at=$2::timestamptz WHERE account_id=$1"
            : "UPDATE app.finance_accounts SET last_reconciled_date=$2::date,last_reconciled_balance_cents=balance_cents WHERE account_id=$1",
          [f.entry.accountId, mode === "closed" ? at : "2026-10-15"]
        );
      });
      f.entry.review = await review();
    }
    const before = await snapshot(f.entry);
    expect(await owner((s) => s.bills!.recordEntry!(f.entry))).toBe(false);
    expect(await snapshot(f.entry)).toEqual(before);
  });
  it("treats a credit expense as additional debt using exact cents", async () => {
    const f = await fresh("credit", 20000);
    expect(await run(billEntryPreviewHandler, f.input)).toMatchObject({
      debt: true,
      beforeCents: 20000,
      afterCents: 21234
    });
    await run(billEntryRecordHandler, f.input);
    expect((await snapshot(f.entry)).account?.balanceCents).toBe(21234);
  });
  it.each([ids.userB, ids.adminUser])(
    "keeps replay lookup and recording private for %s",
    async (actor) => {
      const f = await fresh();
      await run(billEntryRecordHandler, f.input);
      const before = await snapshot(f.entry);
      expect(
        await owner(
          (s) => s.bills!.entryReplay!(f.entry.id, f.entry.digest, f.plan.id, f.plan.anchorDate),
          actor
        )
      ).toBeNull();
      const e = await review(actor);
      expect(
        await owner(
          (s) => s.bills!.recordEntry!({ ...f.entry, id: `manual:${randomUUID()}`, review: e }),
          actor
        )
      ).toBe(false);
      expect(await snapshot(f.entry)).toEqual(before);
    }
  );
});
describe("bill entry capture boundaries", () => {
  it("keeps the original occurrence identity after moving its effective date and amount", async () => {
    const f = await fresh();
    await owner(async (s) =>
      expect(
        await s.billAdjustments!.save(
          {
            planId: f.plan.id,
            dueDate: f.plan.anchorDate,
            plannedDate: "2026-10-10",
            amountCents: 4567
          },
          (await s.budgetPolicy!.get())!,
          at
        )
      ).toBe(true)
    );
    const e = await review();
    f.input.expectedRevision = e.revision;
    f.input.expectedFingerprint = e.fingerprint;
    expect(await run(billEntryPreviewHandler, f.input)).toMatchObject({
      plannedDate: "2026-10-10",
      expectedCents: 4567,
      canRecord: true
    });
    await run(billEntryRecordHandler, f.input);
    expect((await snapshot(f.entry)).decisions).toEqual([
      expect.objectContaining({ dueDate: "2026-10-15", transactionId: f.entry.id })
    ]);
  });
  it("rolls back the entry, balance, policy revision and activity if matching fails late", async () => {
    const f = await fresh(),
      before = await snapshot(f.entry);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        "CREATE FUNCTION app.finance_bill_entry_failure_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late bill match failure'; END $$"
      );
      await client.query(
        "CREATE TRIGGER finance_bill_entry_failure_proof BEFORE INSERT ON app.finance_bill_occurrences FOR EACH ROW EXECUTE FUNCTION app.finance_bill_entry_failure_proof()"
      );
      await expect(owner((s) => s.bills!.recordEntry!(f.entry))).rejects.toThrow(
        /synthetic late bill match failure|db_query_failed/
      );
    } finally {
      await client.query(
        "DROP TRIGGER IF EXISTS finance_bill_entry_failure_proof ON app.finance_bill_occurrences"
      );
      await client.query("DROP FUNCTION IF EXISTS app.finance_bill_entry_failure_proof()");
      await client.end();
    }
    expect(await snapshot(f.entry)).toEqual(before);
  });
  it("does not call an invalidated match an exact completed replay", async () => {
    const f = await fresh();
    await run(billEntryRecordHandler, f.input);
    const before = (await snapshot(f.entry)).account;
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_transactions SET category_id='income' WHERE id=$1",
        [f.entry.id]
      )
    );
    await expect(run(billEntryRecordHandler, f.input)).rejects.toThrow();
    expect((await snapshot(f.entry)).account).toEqual(before);
    expect((await snapshot(f.entry)).entries).toHaveLength(1);
  });
  it("rejects future, sub-cent and mismatched intent before any write", async () => {
    const f = await fresh(),
      before = await snapshot(f.entry);
    for (const change of [
      { date: "2026-10-31" },
      { amountCents: 1.5 },
      { categoryId: "income" },
      { name: "Different bill" }
    ])
      await expect(run(billEntryRecordHandler, { ...f.input, ...change })).rejects.toThrow();
    expect(await snapshot(f.entry)).toEqual(before);
  });
});
