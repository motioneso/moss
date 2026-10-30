import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
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
  cardReservePreviewHandler,
  cardReserveSaveHandler
} from "../../external-modules/finance/src/worker/handlers/card-reserves.js";
import { budgetStatusHandler } from "../../external-modules/finance/src/worker/handlers/budget.js";
import { targetFundHandler } from "../../external-modules/finance/src/worker/handlers/target-funding.js";
import type { ToolFactory } from "../../external-modules/finance/src/worker/registry.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const at = "2026-10-30T12:00:00Z";
const run = (factory: ToolFactory, input: Record<string, unknown>, user = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    factory({
      store: async () => store(scope),
      now: () => new Date(at),
      localTimezone: "UTC",
      kv: { get: async () => null }
    } as unknown as WorkerPorts)(input)
  );
const tokens = async () => {
  const p = (await owner((s) => s.budgetPolicy!.get()))!;
  return { expectedRevision: p.revision, expectedFingerprint: p.fingerprint };
};
const enroll = {
  month: "2026-10",
  accountId: "synthetic-card",
  action: "enroll",
  availableCents: 10000
};
const fund = { ...enroll, action: "fund", availableCents: 20000 };
async function entry(
  id: string,
  amountCents: number,
  categoryId = "groceries",
  accountId = "synthetic-card",
  date = "2026-10-10"
) {
  return owner((s) =>
    s.manual!.createEntry({
      id,
      accountId,
      date,
      name: "Synthetic card entry",
      amountCents,
      isoCurrency: "USD",
      categoryId,
      notes: "",
      cleared: false,
      digest: "b".repeat(64),
      at
    })
  );
}
beforeEach(async () => {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(`TRUNCATE ${ownedTables.join(",")} CASCADE`);
  } finally {
    await client.end();
  }
  for (const user of [ids.userA, ids.userB])
    await owner(async (s) => {
      for (const [accountId, type, openingBalanceCents] of [
        ["synthetic-cash", "depository", 100000],
        ["synthetic-card", "credit", 50000]
      ] as const)
        await s.manual!.createAccount({
          accountId,
          type,
          subtype: type === "credit" ? "credit card" : "checking",
          name: accountId,
          isoCurrency: "USD",
          openingDate: "2026-09-01",
          openingBalanceCents,
          digest: "a".repeat(64),
          at
        });
      await s.budgetPolicy!.configure("USD", false, at);
      await s.setAssignment("2026-10", "groceries", 10000);
    }, user);
});
describe("installed manual-card payment reserves", () => {
  it("previews without writes, enrolls atomically, and preserves historical full-debt math", async () => {
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 40000,
      cardPayments: []
    });
    expect(await entry("buy", 5000)).toBe("created");
    const p = await run(cardReservePreviewHandler, enroll);
    expect(p).toMatchObject({
      readyBeforeCents: 40000,
      readyAfterCents: 80000,
      payment: { availableCents: 15000, fundedCents: 5000, owedCents: 55000 }
    });
    expect(await owner((s) => s.cardReserves!.policies())).toEqual([]);
    const captured = await tokens();
    expect(await run(cardReserveSaveHandler, { ...enroll, ...captured })).toMatchObject({
      status: "ok"
    });
    expect(await owner((s) => s.cardReserves!.assignments())).toEqual([
      { accountId: "synthetic-card", month: "2026-10", assignedCents: 10000 }
    ]);
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 80000,
      cardPayments: [{ fundedCents: 5000, availableCents: 15000 }]
    });
    expect(await run(budgetStatusHandler, { month: "2026-09" })).toMatchObject({
      readyToAssignCents: 50000,
      cardPayments: []
    });
    expect(await run(budgetStatusHandler, { month: "2026-11" })).toMatchObject({
      readyToAssignCents: null,
      readyUnavailable: "future_month",
      cardPayments: [{ availableCents: 15000 }]
    });
    await expect(run(cardReserveSaveHandler, { ...enroll, ...captured })).rejects.toThrow();
    expect(
      (await owner((s) => s.listActivity("2026-01-01", "2027-01-01", 100))).filter(
        (a) => a.kind === "card.enroll"
      )
    ).toHaveLength(1);
  });
  it("sets available payment cash, releases excess, and refuses to spend unavailable Ready", async () => {
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    await run(cardReserveSaveHandler, { ...fund, ...(await tokens()) });
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 70000,
      cardPayments: [{ availableCents: 20000, assignedCents: 20000 }]
    });
    await run(cardReserveSaveHandler, { ...fund, availableCents: 0, ...(await tokens()) });
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 90000,
      cardPayments: [{ availableCents: 0 }]
    });
    await expect(
      run(cardReserveSaveHandler, { ...fund, availableCents: 90001, ...(await tokens()) })
    ).rejects.toThrow(/less payment cash/);
  });
  it("rejects stale reviews after ledger movement, without activity or partial assignment", async () => {
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    const capture = await tokens();
    await entry("later-buy", 100);
    await expect(run(cardReserveSaveHandler, { ...fund, ...capture })).rejects.toThrow(/changed/);
    expect((await owner((s) => s.cardReserves!.assignments()))[0]!.assignedCents).toBe(10000);
    expect(
      (await owner((s) => s.listActivity("2026-01-01", "2027-01-01", 100))).filter(
        (a) => a.kind === "card.cash-set"
      )
    ).toHaveLength(0);
  });
  it("allows exactly one save from competing captures", async () => {
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    const capture = await tokens();
    const results = await Promise.allSettled([
      run(cardReserveSaveHandler, { ...fund, ...capture }),
      run(cardReserveSaveHandler, { ...fund, availableCents: 30000, ...capture })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await owner((s) => s.listActivity("2026-01-01", "2027-01-01", 100))).filter(
        (a) => a.kind === "card.cash-set"
      )
    ).toHaveLength(1);
  });
  it("requires current-month review and explicit complete payment links", async () => {
    await expect(run(cardReservePreviewHandler, { ...enroll, month: "2026-09" })).rejects.toThrow(
      /current month/
    );
    await entry("unlinked", -5000, "transfers");
    await expect(run(cardReservePreviewHandler, enroll)).rejects.toThrow(/unlinked/);
    expect(await owner((s) => s.cardReserves!.policies())).toEqual([]);
  });
  it("consumes an actual linked payment once without changing spending categories", async () => {
    await entry("buy-before-pay", 5000);
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    const accounts = await owner((s) => s.transfers!.accounts());
    const input = {
      operationId: "ab8de280-4147-4498-90f9-bf47386d13d0",
      fromAccountId: "synthetic-cash",
      toAccountId: "synthetic-card",
      fromRevision: accounts.find((a) => a.accountId === "synthetic-cash")!.revision,
      toRevision: accounts.find((a) => a.accountId === "synthetic-card")!.revision,
      date: "2026-10-15",
      amountCents: 10000,
      isoCurrency: "USD",
      cleared: false,
      digest: "c".repeat(64),
      today: "2026-10-30",
      at
    };
    expect(await owner((s) => s.transfers!.create(input))).toBe("created");
    expect(await owner((s) => s.transfers!.create(input))).toBe("unchanged");
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 80000,
      cardPayments: [{ availableCents: 5000, owedCents: 45000, paymentsCents: 10000 }],
      state: { categories: { groceries: { activityCents: 5000 } } }
    });
  });
  it("shows a repair path rather than guessed totals after a later unlinked card transfer", async () => {
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    await entry("unlinked-later", -100, "transfers");
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toEqual({
      month: "2026-10",
      cardLedgerReviewRequired: true,
      readyUnavailable: "card_ledger_review_required",
      readyToAssignCents: null
    });
    await expect(run(cardReserveSaveHandler, { ...fund, ...(await tokens()) })).rejects.toThrow(
      /unlinked/
    );
    await owner(async (s) => {
      const row = (await s.listMonthTransactions("2026-10")).find(
        (r) => r.id === "unlinked-later"
      )!;
      await s.putTransaction({ ...row, categoryId: "groceries" });
    });
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      readyToAssignCents: 80000,
      cardPayments: [{ availableCents: 9900 }]
    });
  });
  it("keeps card reserve tables owner-only, including for administrators", async () => {
    await run(cardReserveSaveHandler, { ...enroll, ...(await tokens()) });
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    const negative = process.env.MOSS_FINANCE_CARD_RLS_NEGATIVE === "1";
    try {
      if (negative)
        for (const table of ["finance_card_policies", "finance_card_assignments"])
          await client.query(`ALTER TABLE app.${table} DISABLE ROW LEVEL SECURITY`);
      for (const user of [ids.userB, ids.adminUser]) {
        expect({
          policies: await owner((s) => s.cardReserves!.policies(), user),
          assignments: await owner((s) => s.cardReserves!.assignments(), user)
        }).toEqual({ policies: [], assignments: [] });
      }
    } finally {
      if (negative)
        for (const table of ["finance_card_policies", "finance_card_assignments"])
          await client.query(
            `ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`
          );
      await client.end();
    }
  });
  it("rejects cross-owner changes and incompatible card currency", async () => {
    const capture = await tokens();
    await expect(
      run(cardReserveSaveHandler, { ...enroll, ...capture }, ids.adminUser)
    ).rejects.toThrow();
    await owner((s) =>
      s.manual!.createAccount({
        accountId: "eur-card",
        type: "credit",
        subtype: "credit card",
        name: "Synthetic euro card",
        isoCurrency: "EUR",
        openingDate: "2026-09-01",
        openingBalanceCents: 100,
        digest: "a".repeat(64),
        at
      })
    );
    await expect(
      run(cardReserveSaveHandler, { ...enroll, accountId: "eur-card", ...(await tokens()) })
    ).rejects.toThrow(/budget currency/);
  });
  it("blocks automatic target funding when refunded payment cash is negative", async () => {
    await run(cardReserveSaveHandler, { ...enroll, availableCents: 0, ...(await tokens()) });
    await entry("refund", -5000);
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      targetFundingOverspent: true,
      cardPayments: [{ availableCents: -5000 }]
    });
    await expect(
      run(targetFundHandler, {
        month: "2026-10",
        categoryIds: ["groceries"],
        expectedAmountsCents: [1],
        ...(await tokens())
      })
    ).rejects.toThrow(/overspending/);
    await run(cardReserveSaveHandler, { ...fund, availableCents: 0, ...(await tokens()) });
    expect(await run(budgetStatusHandler, { month: "2026-10" })).toMatchObject({
      targetFundingOverspent: false,
      cardPayments: [{ availableCents: 0 }]
    });
  });
  it("waits for an earlier ledger mutation then rejects the pre-mutation captured fingerprint", async () => {
    const expected = (await owner((s) => s.budgetPolicy!.get()))!;
    let release!: () => void, signal!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      signal = r;
    });
    const first = owner(async (s) => {
      await s.manual!.createEntry({
        id: "held-buy",
        accountId: "synthetic-card",
        date: "2026-10-10",
        name: "Synthetic held write",
        amountCents: 100,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "",
        cleared: false,
        digest: "c".repeat(64),
        at
      });
      signal();
      await hold;
    });
    await entered;
    const second = owner((s) =>
      s.commitBudgetChange({
        expected,
        month: "2026-10",
        assignments: [],
        cardPolicy: { accountId: "synthetic-card", effectiveMonth: "2026-10" },
        cardAssignment: { accountId: "synthetic-card", month: "2026-10", assignedCents: 10000 },
        activity: []
      })
    );
    // Observe the real PostgreSQL wait, not an optimistic Promise/timing assumption.
    const monitor = new Client({ connectionString: connectionStrings.bootstrap });
    await monitor.connect();
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const result = await monitor.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%' AND pid<>pg_backend_pid()"
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      release();
      await monitor.end();
    }
    await first;
    expect(await second).toBe(false);
    expect(waiting).toBe(true);
    expect(await owner((s) => s.cardReserves!.policies())).toEqual([]);
  });
});
