import { BUDGET_FINGERPRINT_SQL } from "../../external-modules/finance/src/domain/budget-review-sql.js";
import { billsReadHandler } from "../../external-modules/finance/src/worker/handlers/bills.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
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
    query: async (text, params) => {
      if (text.includes("'bill.adjust'") || text.includes("'bill.adjust-reset'")) {
        if (process.env.MOSS_FINANCE_BILL_ADJUST_CAS_NEGATIVE === "1") {
          text = text
            .replace(/revision = \$(\d+)::bigint/g, (_whole, n) => `$${n}::bigint >= 0`)
            .replace(`${BUDGET_FINGERPRINT_SQL} = $7::text`, "$7::text IS NOT NULL")
            .replace(`${BUDGET_FINGERPRINT_SQL} = $5::text`, "$5::text IS NOT NULL");
        }
        if (process.env.MOSS_FINANCE_BILL_TOUCH_NEGATIVE === "1")
          text = text.replace(
            /touched AS \([\s\S]*?\), logged AS/,
            "touched AS (SELECT account_id FROM account WHERE false), logged AS"
          );
      }
      return { rows: [...(await rpc.query(text, params)).rows] as never[] };
    }
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
const at = "2026-10-30T00:00:00Z",
  today = "2026-10-30";
const accountId = "manual:bill-adjust";
const plan: BillPlan = {
  id: randomUUID(),
  name: "Synthetic adjustable bill",
  accountId,
  categoryId: "utilities",
  isoCurrency: "USD",
  amountCents: 10000,
  anchorDate: "2026-01-31",
  cadence: "monthly"
};
const review = () => owner((s) => s.budgetPolicy!.get()).then((r) => r!);
const query = (text: string, params: unknown[] = []) =>
  runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
const read = (from: string, to: string) =>
  owner((s) =>
    billsReadHandler({
      store: async () => s,
      now: () => new Date(at),
      localTimezone: "UTC"
    } as WorkerPorts)({ from, to })
  );
const activities = () => owner((s) => s.listActivity("2026-10-01", "2026-11-01", 500));
const save = (planId: string, dueDate: string, plannedDate: string, amountCents = 10001) =>
  owner(async (s) =>
    s.billAdjustments!.save(
      { planId, dueDate, plannedDate, amountCents },
      (await s.budgetPolicy!.get())!,
      at
    )
  );
async function create(p: BillPlan) {
  expect(await owner(async (s) => s.bills!.create(p, (await s.budgetPolicy!.get())!, at))).toBe(
    true
  );
}
async function zeroPlan(name: string) {
  const id = `manual:${name}`;
  await owner((s) =>
    s.manual!.createAccount({
      accountId: id,
      name: "Synthetic zero bill ledger",
      type: "depository",
      subtype: "checking",
      isoCurrency: "USD",
      openingDate: "2026-01-01",
      openingBalanceCents: 0,
      digest: "c".repeat(64),
      at
    })
  );
  const p = {
    ...plan,
    id: randomUUID(),
    accountId: id,
    cadence: "once" as const,
    anchorDate: "2026-01-01"
  };
  await create(p);
  return p;
}
beforeAll(async () => {
  for (const actor of [ids.userA, ids.userB])
    await owner(async (s) => {
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic adjustable ledger",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-01-01",
        openingBalanceCents: 100000,
        digest: "a".repeat(64),
        at
      });
      await s.budgetPolicy!.configure("USD", false, at);
    }, actor);
  await owner((s) =>
    s.manual!.createEntry({
      id: "manual:adjust-payment",
      accountId,
      name: "Synthetic bill receipt",
      date: "2026-02-02",
      amountCents: 10025,
      isoCurrency: "USD",
      categoryId: "utilities",
      notes: "Synthetic private note",
      cleared: true,
      digest: "b".repeat(64),
      at
    })
  );
  await create(plan);
});
describe("owned one-off bill adjustments", () => {
  it("changes one projection atomically without changing its plan, ledger or account values", async () => {
    const money = await owner((s) => s.getAccount(accountId)),
      rows = await owner((s) => s.listMonthTransactions("2026-02"));
    const before = await review(),
      count = (await activities()).length;
    expect(await save(plan.id, "2026-01-31", "2026-02-03")).toBe(true);
    expect(await owner((s) => s.billAdjustments!.rows("2026-02-01", "2026-02-28"))).toMatchObject([
      { planId: plan.id, dueDate: "2026-01-31", plannedDate: "2026-02-03", amountCents: 10001 }
    ]);
    expect((await review()).revision).toBe(before.revision + 1);
    expect((await review()).fingerprint).not.toBe(before.fingerprint);
    expect(await owner((s) => s.bills!.plans())).toEqual([{ ...plan, endDate: null }]);
    expect(await owner((s) => s.getAccount(accountId))).toEqual(money);
    expect(await owner((s) => s.listMonthTransactions("2026-02"))).toEqual(rows);
    expect(await activities()).toHaveLength(count + 1);
    expect(JSON.stringify(await activities())).not.toContain("Synthetic private note");
  });
  it("moves into and out of month windows without shifting later dates and resets to the original plan", async () => {
    expect((await read("2026-01-01", "2026-01-31")).occurrences).toEqual([]);
    expect((await read("2026-02-01", "2026-02-28")).occurrences).toMatchObject([
      { dueDate: "2026-01-31", plannedDate: "2026-02-03", expectedCents: 10001 },
      { dueDate: "2026-02-28", plannedDate: "2026-02-28", expectedCents: 10000 }
    ]);
    expect(await save(plan.id, "2026-01-31", "2026-03-02", 12345)).toBe(true);
    expect((await read("2026-02-01", "2026-02-28")).occurrences as unknown[]).toHaveLength(1);
    expect((await read("2026-03-01", "2026-03-31")).occurrences).toMatchObject([
      { dueDate: "2026-01-31", plannedDate: "2026-03-02", expectedCents: 12345 },
      { dueDate: "2026-03-31", plannedDate: "2026-03-31", expectedCents: 10000 }
    ]);
    expect(
      await owner(async (s) =>
        s.billAdjustments!.reset(plan.id, "2026-01-31", (await s.budgetPolicy!.get())!, at)
      )
    ).toBe(true);
    expect((await read("2026-01-01", "2026-01-31")).occurrences).toMatchObject([
      { dueDate: "2026-01-31", plannedDate: "2026-01-31", expectedCents: 10000, adjusted: false }
    ]);
  });
  it("rejects stale and overlapping reviews with no partial change or duplicate activity", async () => {
    const e = await review(),
      count = (await activities()).length;
    const results = await Promise.all(
      ["2026-04-01", "2026-04-02"].map((plannedDate) =>
        owner((s) =>
          s.billAdjustments!.save(
            { planId: plan.id, dueDate: "2026-02-28", plannedDate, amountCents: 12000 },
            e,
            at
          )
        )
      )
    );
    expect(results.sort()).toEqual([false, true]);
    expect(
      await owner((s) =>
        s.billAdjustments!.save(
          { planId: plan.id, dueDate: "2026-02-28", plannedDate: "2026-04-03", amountCents: 1 },
          e,
          at
        )
      )
    ).toBe(false);
    expect(await activities()).toHaveLength(count + 1);
  });
  it("rechecks the fingerprint even when a competing change does not increment the policy revision", async () => {
    const e = await review(),
      count = (await activities()).length;
    await query(
      "UPDATE app.finance_bill_adjustments SET amount_cents=13000 WHERE plan_id=$1::uuid AND due_date='2026-02-28'",
      [plan.id]
    );
    expect((await review()).revision).toBe(e.revision);
    expect(
      await owner((s) =>
        s.billAdjustments!.save(
          { planId: plan.id, dueDate: "2026-02-28", plannedDate: "2026-04-03", amountCents: 1 },
          e,
          at
        )
      )
    ).toBe(false);
    expect(await activities()).toHaveLength(count);
  });
  it("confines reads and writes to the owner, including administrator actors", async () => {
    const e = await review(),
      observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    const negative = process.env.MOSS_FINANCE_BILL_ADJUST_RLS_NEGATIVE === "1";
    try {
      if (negative)
        await observer.query("ALTER TABLE app.finance_bill_adjustments DISABLE ROW LEVEL SECURITY");
      for (const actor of [ids.userB, ids.adminUser]) {
        expect(
          await owner((s) => s.billAdjustments!.rows("2026-01-01", "2026-12-31"), actor)
        ).toEqual([]);
        expect(
          await owner(
            (s) =>
              s.billAdjustments!.save(
                {
                  planId: plan.id,
                  dueDate: "2026-01-31",
                  plannedDate: "2026-04-01",
                  amountCents: 1
                },
                e,
                at
              ),
            actor
          )
        ).toBe(false);
      }
    } finally {
      if (negative)
        await observer.query(
          "ALTER TABLE app.finance_bill_adjustments ENABLE ROW LEVEL SECURITY; ALTER TABLE app.finance_bill_adjustments FORCE ROW LEVEL SECURITY"
        );
      await observer.end();
    }
  });
  it("validates original schedule membership in SQL for every supported recurrence", async () => {
    for (const [cadence, anchorDate, dueDate, invalid] of [
      ["monthly", "2024-01-31", "2024-02-29", "2024-02-28"],
      ["yearly", "2024-02-29", "2025-02-28", "2025-03-01"],
      ["weekly", "2026-01-01", "2026-01-08", "2026-01-09"],
      ["fortnightly", "2026-01-01", "2026-01-15", "2026-01-16"]
    ] as const) {
      const p = { ...plan, id: randomUUID(), cadence, anchorDate };
      await create(p);
      expect(await save(p.id, invalid, "2026-10-31")).toBe(false);
      expect(await save(p.id, dueDate, "2026-10-31")).toBe(true);
    }
  });
  it("preserves reviewed occurrences and loads moved decisions by their original identity", async () => {
    const p = { ...plan, id: randomUUID() };
    await create(p);
    expect(await save(p.id, "2026-03-31", "2026-02-03", 10100)).toBe(true);
    expect(
      await owner(async (s) =>
        s.bills!.decide(
          {
            planId: p.id,
            dueDate: "2026-03-31",
            state: "matched",
            transactionId: "manual:adjust-payment"
          },
          (await s.budgetPolicy!.get())!,
          at
        )
      )
    ).toBe(true);
    const projected = (await read("2026-02-01", "2026-02-28")).occurrences as {
      planId: string;
      dueDate: string;
      state: string;
      actualCents: number;
    }[];
    expect(projected.find((o) => o.planId === p.id && o.dueDate === "2026-03-31")).toMatchObject({
      state: "posted",
      actualCents: 10025
    });
    expect(await save(p.id, "2026-03-31", "2026-02-04")).toBe(false);
    expect(
      await owner(async (s) =>
        s.billAdjustments!.reset(p.id, "2026-03-31", (await s.budgetPolicy!.get())!, at)
      )
    ).toBe(false);
    expect(
      await owner((s) => s.billAdjustments!.claimedTransactionIds(["manual:adjust-payment"]))
    ).toEqual(["manual:adjust-payment"]);
    expect((await read("2026-02-01", "2026-02-28")).transactions).toEqual([]);
    expect(
      await owner(async (s) =>
        s.bills!.clear(p.id, "2026-03-31", (await s.budgetPolicy!.get())!, at)
      )
    ).toBe(true);
    expect(
      await owner(async (s) =>
        s.billAdjustments!.reset(p.id, "2026-03-31", (await s.budgetPolicy!.get())!, at)
      )
    ).toBe(true);
  });
  it("excludes a transaction claimed outside the visible occurrence window", async () => {
    const p = { ...plan, id: randomUUID(), cadence: "once" as const, anchorDate: "2026-06-01" };
    await create(p);
    expect(
      await owner(async (s) =>
        s.bills!.decide(
          {
            planId: p.id,
            dueDate: p.anchorDate,
            state: "matched",
            transactionId: "manual:adjust-payment"
          },
          (await s.budgetPolicy!.get())!,
          at
        )
      )
    ).toBe(true);
    expect((await read("2026-02-01", "2026-02-28")).transactions).toEqual([]);
  });
  it("keeps a future adjusted one-time bill from being erased by Stop or account Close", async () => {
    const p = await zeroPlan("adjusted-future");
    expect((await owner((s) => s.accountLifecycle!.review(p.accountId, today)))?.canClose).toBe(
      true
    );
    expect(await save(p.id, p.anchorDate, "2026-11-01")).toBe(true);
    expect(
      (await owner((s) => s.accountLifecycle!.review(p.accountId, today)))?.blockers
    ).toContain("future_plans");
    expect(
      await owner(async (s) => s.bills!.stop(p.id, today, (await s.budgetPolicy!.get())!, at))
    ).toBe(false);
    expect(
      await owner(async (s) =>
        s.billAdjustments!.reset(p.id, p.anchorDate, (await s.budgetPolicy!.get())!, at)
      )
    ).toBe(true);
    expect(
      await owner(async (s) => s.bills!.stop(p.id, today, (await s.budgetPolicy!.get())!, at))
    ).toBe(true);
  });
  it("invalidates a close review when an adjustment commits while the close waits on its account", async () => {
    const p = await zeroPlan("adjust-close-wait"),
      old = await owner((s) => s.accountLifecycle!.review(p.accountId, today)),
      e = await review();
    let unlock!: () => void, acquired!: () => void;
    const release = new Promise<void>((resolve) => {
        unlock = resolve;
      }),
      held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
    const blocker = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query(
        "SELECT account_id FROM app.finance_accounts WHERE account_id=$1 FOR UPDATE",
        [p.accountId]
      );
      acquired();
      await release;
      expect(
        await store(scope).billAdjustments!.save(
          { planId: p.id, dueDate: p.anchorDate, plannedDate: "2026-11-01", amountCents: 10000 },
          e,
          at
        )
      ).toBe(true);
    });
    await held;
    const closing = owner((s) =>
      s.accountLifecycle!.update({
        accountId: p.accountId,
        today,
        expectedRevision: old!.revision,
        operation: "close",
        at
      })
    );
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const r = await observer.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%reviewed AS MATERIALIZED%' AND pid<>pg_backend_pid()"
          );
          expect(r.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 }
      );
    } finally {
      unlock();
      await observer.end();
    }
    await blocker;
    expect(await closing).toBe(false);
    expect((await owner((s) => s.getAccount(p.accountId)))?.archivedAt ?? null).toBeNull();
  });
  it("refuses an adjustment after a competing account close wins the lock", async () => {
    const p = await zeroPlan("close-adjust-wait"),
      old = await owner((s) => s.accountLifecycle!.review(p.accountId, today)),
      e = await review();
    let unlock!: () => void, acquired!: () => void;
    const release = new Promise<void>((resolve) => {
        unlock = resolve;
      }),
      held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
    const blocker = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query(
        "SELECT account_id FROM app.finance_accounts WHERE account_id=$1 FOR UPDATE",
        [p.accountId]
      );
      acquired();
      await release;
      expect(
        await store(scope).accountLifecycle!.update({
          accountId: p.accountId,
          today,
          expectedRevision: old!.revision,
          operation: "close",
          at
        })
      ).toBe(true);
    });
    await held;
    const adjusting = owner((s) =>
      s.billAdjustments!.save(
        { planId: p.id, dueDate: p.anchorDate, plannedDate: "2026-11-01", amountCents: 1 },
        e,
        at
      )
    );
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const r = await observer.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%account AS MATERIALIZED%' AND pid<>pg_backend_pid()"
          );
          expect(r.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 }
      );
    } finally {
      unlock();
      await observer.end();
    }
    await blocker;
    expect(await adjusting).toBe(false);
    expect(await owner((s) => s.billAdjustments!.rows("2026-11-01", "2026-11-30"))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ planId: p.id })])
    );
  });
});
