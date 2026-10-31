import {
  targetRemoveHandler,
  targetSetHandler
} from "../../external-modules/finance/src/worker/handlers/targets.js";
import type * as Funding from "../../external-modules/finance/src/domain/target-funding.js";
import { BUDGET_FINGERPRINT_SQL } from "../../external-modules/finance/src/domain/budget-review-sql.js";
import { budgetStatusHandler } from "../../external-modules/finance/src/worker/handlers/budget.js";
import { targetFundHandler } from "../../external-modules/finance/src/worker/handlers/target-funding.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { TargetFundingLine } from "../../external-modules/finance/src/domain/target-funding.js";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
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
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => {
      if (
        process.env.MOSS_FINANCE_TARGET_CAS_NEGATIVE === "1" &&
        text.includes("jsonb_to_recordset($2::jsonb) AS x(category_id text")
      ) {
        text = text
          .replace("revision = $4::bigint", "$4::bigint >= 0")
          .replace(`${BUDGET_FINGERPRINT_SQL} = $5::text`, "$5::text IS NOT NULL");
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
// Fixture-only negative control: suppress the new ready-money comparison while retaining real SQL.
vi.mock("../../external-modules/finance/src/domain/target-funding.js", async (original) => {
  const actual = await original<typeof Funding>();
  return {
    ...actual,
    hasTargetFundingOverspending: (
      ...args: Parameters<typeof actual.hasTargetFundingOverspending>
    ) =>
      process.env.MOSS_FINANCE_TARGET_OVERSPENT_NEGATIVE === "1"
        ? false
        : actual.hasTargetFundingOverspending(...args),
    selectTargetFunding: (...args: Parameters<typeof actual.selectTargetFunding>) =>
      actual.selectTargetFunding(
        args[0],
        args[1],
        args[2],
        process.env.MOSS_FINANCE_TARGET_READY_NEGATIVE === "1" ? Number.MAX_SAFE_INTEGER : args[3]
      )
  };
});
const at = "2026-10-30T12:00:00Z",
  month = "2026-10",
  accountId = "manual:target-funding";
const ports = (s: ReturnType<typeof store>) =>
  ({ store: async () => s, now: () => new Date(at), localTimezone: "UTC" }) as WorkerPorts;
const status = (m = month) => owner((s) => budgetStatusHandler(ports(s))({ month: m }));
const snapshot = () =>
  owner(async (s) => ({
    accounts: await s.listAccounts(),
    transactions: await s.listMonthTransactions(month),
    history: await s.targets!.versions!(),
    ledger: await s.getLedger(month),
    prior: await s.getLedger("2026-09"),
    activity: await s.listActivity("2026-10-01", "2026-11-01", 500)
  }));
function command(
  view: Awaited<ReturnType<typeof status>>,
  selected: string[] = ["groceries", "savings"]
) {
  const lines = view.targetFunding as TargetFundingLine[];
  return {
    month,
    categoryIds: selected,
    expectedAmountsCents: selected.map((id) => lines.find((l) => l.categoryId === id)!.amountCents),
    expectedRevision: view.revision,
    expectedFingerprint: view.fingerprint
  };
}
const fund = (input: Record<string, unknown>, actor: string = ids.userA) =>
  owner((s) => targetFundHandler(ports(s))(input), actor);
beforeEach(async () => {
  for (const actor of [ids.userA, ids.userB])
    await runner.withDataContext({ actorUserId: actor }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      for (const table of [...ownedTables].reverse()) await rpc.query(`DELETE FROM ${table}`);
      const s = store(scope);
      await s.budgetPolicy!.configure("USD", false, at);
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic target cash",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-09-01",
        openingBalanceCents: 500000,
        digest: "a".repeat(64),
        at
      });
      await s.manual!.createEntry({
        id: "manual:target-receipt",
        accountId,
        name: "Synthetic groceries",
        date: "2026-10-02",
        amountCents: 800,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "Synthetic private note",
        cleared: true,
        digest: "b".repeat(64),
        at
      });
      for (const [m, assignments] of [
        ["2026-09", [{ categoryId: "savings", amountCents: 9500 }]],
        [
          month,
          [
            { categoryId: "groceries", amountCents: 1000 },
            { categoryId: "savings", amountCents: 500 }
          ]
        ]
      ] as const)
        expect(
          await s.commitBudgetChange({
            expected: (await s.budgetPolicy!.get())!,
            month: m,
            assignments: [...assignments],
            activity: []
          })
        ).toBe(true);
      for (const target of [
        {
          categoryId: "savings",
          effectiveMonth: "2026-09",
          kind: "balance" as const,
          amountCents: 50000,
          dueDate: "2026-12-31"
        },
        {
          categoryId: "groceries",
          effectiveMonth: "2026-09",
          kind: "monthly" as const,
          amountCents: 10000,
          dueDate: null
        },
        {
          categoryId: "groceries",
          effectiveMonth: month,
          kind: "monthly" as const,
          amountCents: 12345,
          dueDate: null
        },
        {
          categoryId: "savings",
          effectiveMonth: month,
          kind: "balance" as const,
          amountCents: 60000,
          dueDate: "2026-12-31"
        }
      ])
        expect(await s.targets!.save(target, (await s.budgetPolicy!.get())!, at)).toBe(true);
    });
});
describe("installed selected target funding", () => {
  it("refills carry plus assignments without treating current spending/refunds as another funding request", async () => {
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:refill-spending",
        accountId,
        name: "Synthetic saved spending",
        date: "2026-10-10",
        amountCents: 1200,
        isoCurrency: "USD",
        categoryId: "savings",
        notes: "Synthetic private note",
        cleared: false,
        digest: "d".repeat(64),
        at
      })
    );
    const before = await snapshot(),
      view = await status();
    await owner((s) =>
      targetSetHandler(ports(s))({
        month,
        categoryId: "savings",
        kind: "refill",
        amountCents: 12501,
        expectedRevision: view.revision,
        expectedFingerprint: view.fingerprint
      })
    );
    const saved = await status();
    expect(saved.targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "savings",
          kind: "refill",
          previousCents: 500,
          amountCents: 2501,
          newAssignedCents: 3001
        })
      ])
    );
    const edited = await snapshot();
    expect(edited.accounts).toEqual(before.accounts);
    expect(edited.transactions).toEqual(before.transactions);
    expect(edited.ledger).toEqual(before.ledger);
    expect(
      edited.history.find((t) => t.categoryId === "savings" && t.effectiveMonth === month)
    ).toEqual({
      categoryId: "savings",
      effectiveMonth: month,
      kind: "refill",
      amountCents: 12501,
      dueDate: null
    });
    expect(await fund(command(saved, ["savings"]))).toMatchObject({
      status: "ok",
      totalCents: 2501
    });
    const funded = await snapshot();
    expect(funded.accounts).toEqual(edited.accounts);
    expect(funded.transactions).toEqual(edited.transactions);
    expect(funded.history).toEqual(edited.history);
    expect(funded.prior).toEqual(before.prior);
    expect(funded.ledger?.assignments.savings).toBe(3001);
    expect(funded.history.filter((t) => t.effectiveMonth === "2026-09")).toEqual(
      before.history.filter((t) => t.effectiveMonth === "2026-09")
    );
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:refill-refund",
        accountId,
        name: "Synthetic saved refund",
        date: "2026-10-30",
        amountCents: -500,
        isoCurrency: "USD",
        categoryId: "savings",
        notes: "",
        cleared: false,
        digest: "e".repeat(64),
        at
      })
    );
    expect((await status()).targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "savings",
          amountCents: 0,
          unavailableReason: "reached"
        })
      ])
    );
    expect((await status("2026-11")).targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: "savings", kind: "refill", amountCents: 700 })
      ])
    );
  });
  it("persists weekly plans, funds the calendar total and preserves historical targets and ledger receipts", async () => {
    const before = await snapshot(),
      view = await status();
    await owner((s) =>
      targetSetHandler(ports(s))({
        month,
        categoryId: "groceries",
        kind: "weekly",
        amountCents: 2501,
        weekday: 5,
        expectedRevision: view.revision,
        expectedFingerprint: view.fingerprint
      })
    );
    const saved = await status();
    expect(saved.targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "groceries",
          kind: "weekly",
          amountCents: 11505,
          weekly: { weekday: 5, occurrences: 5, totalCents: 12505 }
        })
      ])
    );
    const edited = await snapshot();
    expect(edited.accounts).toEqual(before.accounts);
    expect(edited.transactions).toEqual(before.transactions);
    expect(edited.ledger).toEqual(before.ledger);
    expect(edited.prior).toEqual(before.prior);
    expect(edited.history.filter((t) => t.effectiveMonth === "2026-09")).toEqual(
      before.history.filter((t) => t.effectiveMonth === "2026-09")
    );
    expect((await status("2026-11")).targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "groceries",
          weekly: { weekday: 5, occurrences: 4, totalCents: 10004 }
        })
      ])
    );
    expect(await fund(command(saved, ["groceries"]))).toMatchObject({
      status: "ok",
      totalCents: 11505
    });
    expect((await snapshot()).ledger?.assignments.groceries).toBe(12505);
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:weekly-spending",
        accountId,
        name: "Synthetic later groceries",
        date: "2026-10-30",
        amountCents: 1,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "",
        cleared: false,
        digest: "c".repeat(64),
        at
      })
    );
    expect((await status()).targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "groceries",
          amountCents: 0,
          unavailableReason: "reached"
        })
      ])
    );
    const latest = await status();
    await owner((s) =>
      targetRemoveHandler(ports(s))({
        month,
        categoryId: "groceries",
        expectedRevision: latest.revision,
        expectedFingerprint: latest.fingerprint
      })
    );
    expect(
      (await snapshot()).history.find(
        (t) => t.categoryId === "groceries" && t.effectiveMonth === month
      )
    ).toEqual({
      categoryId: "groceries",
      effectiveMonth: month,
      kind: "removed",
      amountCents: 0,
      dueDate: null
    });
  });
  it("invalidates a captured funding review when only the weekly day changes with the same monthly total", async () => {
    await owner(async (s) =>
      s.targets!.save(
        {
          categoryId: "groceries",
          effectiveMonth: month,
          kind: "weekly",
          amountCents: 2501,
          weekday: 5,
          dueDate: null
        },
        (await s.budgetPolicy!.get())!,
        at
      )
    );
    const captured = await status();
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_targets SET weekday=6 WHERE category_id='groceries' AND effective_month=$1",
        [month]
      )
    );
    const changed = await status();
    expect(changed.revision).toBe(captured.revision);
    expect(changed.fingerprint).not.toBe(captured.fingerprint);
    const amounts = (view: typeof changed) =>
      (view.targetFunding as TargetFundingLine[]).find((l) => l.categoryId === "groceries")!
        .amountCents;
    expect(amounts(changed)).toBe(amounts(captured));
    const stable = await snapshot();
    await expect(fund(command(captured, ["groceries"]))).rejects.toThrow();
    expect(await snapshot()).toEqual(stable);
  });
  it("enforces target shapes in installed SQL without changing saved history on rejection", async () => {
    const stable = await snapshot();
    for (const shape of [
      { kind: "weekly" as const, amountCents: 100 },
      { kind: "weekly" as const, amountCents: 100, weekday: 7 },
      { kind: "weekly" as const, amountCents: 100, weekday: 5, dueDate: "2026-10-30" },
      { kind: "weekly" as const, amountCents: 1801439850948199, weekday: 5 },
      { kind: "monthly" as const, amountCents: 100, weekday: 5 },
      { kind: "refill" as const, amountCents: 100, weekday: 5 },
      { kind: "refill" as const, amountCents: 100, dueDate: "2026-10-30" },
      { kind: "refill" as const, amountCents: 0 }
    ]) {
      await expect(
        owner(async (s) =>
          s.targets!.save(
            { categoryId: "groceries", effectiveMonth: month, dueDate: null, ...shape },
            (await s.budgetPolicy!.get())!,
            at
          )
        )
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(stable);
    }
  });
  it("atomically adds exact suggestions and activity while preserving accounts, receipts and historical targets", async () => {
    const before = await snapshot(),
      view = await status();
    expect(view).toMatchObject({
      readyToAssignCents: 489000,
      targetFunding: [
        expect.objectContaining({ categoryId: "groceries", amountCents: 11345 }),
        expect.objectContaining({ categoryId: "savings", amountCents: 16667 })
      ]
    });
    expect(await fund(command(view))).toMatchObject({
      status: "ok",
      applied: 2,
      totalCents: 28012,
      readyBeforeCents: 489000,
      readyAfterCents: 460988
    });
    const after = await snapshot();
    expect(after.ledger?.assignments).toEqual({ groceries: 12345, savings: 17167 });
    expect(after.accounts).toEqual(before.accounts);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.history).toEqual(before.history);
    expect(after.prior).toEqual(before.prior);
    expect(after.activity).toHaveLength(before.activity.length + 2);
    expect(after.activity.filter((a) => a.kind === "budget.assign")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ undo: { month, categoryId: "groceries", amountCents: 1000 } }),
        expect.objectContaining({ undo: { month, categoryId: "savings", amountCents: 500 } })
      ])
    );
    expect((await status()).readyToAssignCents).toBe(460988);
    expect((await status()).targetFunding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: "groceries",
          unavailableReason: "reached",
          amountCents: 0
        })
      ])
    );
    const stable = await snapshot();
    await expect(fund(command(await status(), ["groceries"]))).rejects.toThrow();
    expect(await snapshot()).toEqual(stable);
  });
  it("rejects a selection above ready money without a partial assignment or activity", async () => {
    await owner(async (s) =>
      s.targets!.save(
        {
          categoryId: "groceries",
          effectiveMonth: month,
          kind: "monthly",
          amountCents: 600000,
          dueDate: null
        },
        (await s.budgetPolicy!.get())!,
        at
      )
    );
    const before = await snapshot(),
      view = await status();
    await expect(fund(command(view, ["groceries"]))).rejects.toThrow(/ready/i);
    expect(await snapshot()).toEqual(before);
  });
  it("requires covering category overspending even when ready money is positive", async () => {
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:unfunded-dining",
        accountId,
        name: "Synthetic overspent meal",
        date: "2026-10-03",
        amountCents: 100,
        isoCurrency: "USD",
        categoryId: "dining",
        notes: "",
        cleared: false,
        digest: "c".repeat(64),
        at
      })
    );
    const view = await status(),
      before = await snapshot();
    expect(view.readyToAssignCents).toBeGreaterThan(28012);
    await expect(fund(command(view))).rejects.toThrow(/overspending/i);
    expect(await snapshot()).toEqual(before);
    expect(view.targetFundingOverspent).toBe(true);
  });
  it("requires exact captured guidance and current local month", async () => {
    const view = await status(),
      input = command(view),
      before = await snapshot();
    for (const invalid of [
      { expectedAmountsCents: [11344, 16667] },
      { month: "2026-09" },
      { month: "2026-11" },
      { categoryIds: ["groceries", "groceries"] },
      { categoryIds: ["income"], expectedAmountsCents: [1] },
      { expectedAmountsCents: [0, 16667] }
    ])
      await expect(fund({ ...input, ...invalid })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("rejects stale targets and foreign or administrator reviews without mutation", async () => {
    const input = command(await status());
    await owner(async (s) =>
      s.targets!.save(
        {
          categoryId: "groceries",
          effectiveMonth: month,
          kind: "monthly",
          amountCents: 20000,
          dueDate: null
        },
        (await s.budgetPolicy!.get())!,
        at
      )
    );
    const before = await snapshot();
    await expect(fund(input)).rejects.toThrow();
    for (const actor of [ids.userB, ids.adminUser])
      await expect(fund(input, actor)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a changed target fingerprint even when its revision was not incremented", async () => {
    const view = await status(),
      input = command(view);
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_targets SET amount_cents=20000 WHERE category_id='groceries' AND effective_month=$1",
        [month]
      )
    );
    const before = await snapshot(),
      changed = await status();
    expect(changed.revision).toBe(view.revision);
    expect(changed.fingerprint).not.toBe(view.fingerprint);
    await expect(fund(input)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("commits one winner when both handlers finish their reads before competing writes", async () => {
    const input = command(await status());
    let release!: () => void,
      arrivals = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = Promise.allSettled(
      [0, 1].map(() =>
        owner((s) => {
          const commit = s.commitBudgetChange.bind(s);
          s.commitBudgetChange = async (change) => {
            arrivals += 1;
            await held;
            return commit(change);
          };
          return targetFundHandler(ports(s))(input);
        })
      )
    );
    try {
      await vi.waitFor(() => expect(arrivals).toBe(2), { timeout: 5000, interval: 25 });
    } finally {
      release();
    }
    const results = await jobs;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await snapshot()).activity.filter((a) => a.kind === "budget.assign")).toHaveLength(2);
    expect((await owner((s) => s.getLedger(month)))?.assignments).toEqual({
      groceries: 12345,
      savings: 17167
    });
  });
  it("refuses archived and flexible-pool target selection without changing assignments", async () => {
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_categories SET archived_at=$1::timestamptz WHERE id='groceries'",
        [at]
      )
    );
    const archived = await status(),
      before = await snapshot();
    await expect(fund(command(archived, ["groceries"]))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await owner(async (s) =>
      s.commitBudgetChange({
        expected: (await s.budgetPolicy!.get())!,
        month,
        assignments: [],
        activity: [],
        flexPolicy: { month, active: true, flexIds: ["savings"], nonMonthlyIds: [] }
      })
    );
    const pooled = await status(),
      prior = await snapshot();
    await expect(fund(command(pooled, ["savings"]))).rejects.toThrow();
    expect(await snapshot()).toEqual(prior);
    const captured = await status();
    const removal = {
      month,
      categoryId: "savings",
      expectedRevision: captured.revision,
      expectedFingerprint: captured.fingerprint
    };
    expect(await owner((s) => targetRemoveHandler(ports(s))(removal))).toMatchObject({
      status: "ok"
    });
    const removed = await snapshot();
    expect(removed.ledger).toEqual(prior.ledger);
    expect(removed.accounts).toEqual(prior.accounts);
    expect(removed.transactions).toEqual(prior.transactions);
    expect(await owner((s) => s.targets!.forMonth("2026-09"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: "savings", amountCents: 50000 })
      ])
    );
    expect((await status()).targets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ categoryId: "savings" })])
    );
    const stable = await snapshot();
    await expect(owner((s) => targetRemoveHandler(ports(s))(removal))).rejects.toThrow();
    expect(await snapshot()).toEqual(stable);
  });
});
