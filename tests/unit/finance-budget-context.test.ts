import { describe, expect, it } from "vitest";
import {
  budgetRows,
  fundingAt,
  kvStore,
  type AccountRecord,
  type FinanceKv,
  type TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  budgetContext,
  requireBudgetPolicy
} from "../../external-modules/finance/src/worker/handlers/budget-context.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { budgetAccountFixture, usdBudgetPolicy } from "./helpers/finance-budget-policy.js";

const account = (id: string, over: Partial<AccountRecord> = {}): AccountRecord => ({
  ...budgetAccountFixture(id),
  source: "manual",
  openingDate: "2026-01-01",
  openingBalanceCents: 10000,
  balanceCents: 9800,
  ...over
});
const row = (id: string, over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id,
  accountId: "cash",
  date: "2026-01-10",
  amountCents: 100,
  isoCurrency: "USD",
  name: "Synthetic purchase",
  merchant: null,
  plaidCategory: null,
  categoryId: "groceries",
  pending: false,
  pendingTransactionId: null,
  categorizedBy: "user",
  ...over
});
function fixture() {
  const values = new Map<string, Record<string, unknown>>();
  const kv: FinanceKv = {
    get: async (ns, key) => structuredClone(values.get(`${ns}|${key}`) ?? null),
    set: async (ns, key, value) => {
      values.set(`${ns}|${key}`, structuredClone(value));
    },
    delete: async (ns, key) => {
      return values.delete(`${ns}|${key}`);
    },
    list: async (ns) =>
      [...values.keys()]
        .filter((key) => key.startsWith(`${ns}|`))
        .map((key) => key.slice(ns.length + 1))
  };
  const store = { ...kvStore(kv), budgetPolicy: usdBudgetPolicy };
  const ports = {
    now: () => new Date("2026-02-15T12:00:00Z"),
    localTimezone: "Etc/UTC",
    store: async () => store
  } as WorkerPorts;
  return { store, ports, kv };
}
describe("budget currency, funding scope and dates", () => {
  it("keeps earlier months readable when a later enrolled-card ledger needs repair", async () => {
    const { store, ports } = fixture();
    await store.putAccount(account("cash", { balanceCents: 10000 }));
    await store.putAccount(
      account("card", {
        type: "credit",
        subtype: "credit card",
        openingBalanceCents: 4000,
        balanceCents: 4000
      })
    );
    await store.setAssignment("2026-02", "groceries", 1000);
    await store.putTransactionChunk("card", "2026-02", [
      row("purchase", { accountId: "card", date: "2026-02-10", source: "manual" })
    ]);
    await store.putTransactionChunk("card", "2026-03", [
      row("unlinked", {
        accountId: "card",
        date: "2026-03-10",
        amountCents: -100,
        categoryId: "transfers",
        source: "manual"
      })
    ]);
    const cards = {
      ...store,
      cardReserves: {
        policies: async () => [{ accountId: "card", effectiveMonth: "2026-02" }],
        assignments: async () => [{ accountId: "card", month: "2026-02", assignedCents: 400 }]
      }
    };
    const clock = { ...ports, now: () => new Date("2026-04-15T12:00:00Z") };
    expect(await budgetContext(clock, cards, "2026-01")).toMatchObject({
      readyToAssignCents: 6000,
      cardPayments: []
    });
    expect(await budgetContext(clock, cards, "2026-02")).toMatchObject({
      readyToAssignCents: 8600,
      cardPayments: [{ owedCents: 4100, availableCents: 500 }]
    });
    await expect(budgetContext(clock, cards, "2026-03")).rejects.toThrow(/unlinked/);
  });
  it("does not silently infer a currency for old storage or legacy assignments", async () => {
    const { store, ports } = fixture();
    const legacy = { ...store, budgetPolicy: undefined };
    await store.setAssignment("2026-01", "groceries", 1000);
    expect(await budgetContext(ports, legacy, "2026-02")).toMatchObject({
      setupRequired: true,
      storageReady: false,
      legacyMonthCount: 1,
      isoCurrency: null
    });
    await expect(requireBudgetPolicy(legacy)).rejects.toThrow("storage migration");
    await expect(
      requireBudgetPolicy({ ...store, budgetPolicy: { ...usdBudgetPolicy, get: async () => null } })
    ).rejects.toThrow("working currency");
  });
  it("filters orphan, tracking, other-currency, pending and future rows before transfer inference", () => {
    const accounts = [
      account("cash"),
      account("eur", { isoCurrency: "EUR" }),
      account("asset", { type: "other", subtype: "asset" })
    ];
    const rows = [
      row("posted"),
      row("pending", { pending: true }),
      row("future", { date: "2026-03-01" }),
      row("e", { accountId: "eur", isoCurrency: "EUR" }),
      row("wrong", { isoCurrency: "EUR" }),
      row("tracking", { accountId: "asset" }),
      row("orphan", { accountId: "gone" })
    ];
    expect(budgetRows(accounts, "USD", rows, "2026-02-15").map((r) => r.id)).toEqual(["posted"]);
  });
  it("reconstructs manual month-end cash and debt from the baseline without today's balance", async () => {
    const { store } = fixture();
    const accounts = [
      account("cash"),
      account("card", { type: "credit", openingBalanceCents: 4000, balanceCents: 999999 }),
      account("later", { openingDate: "2026-02-01" })
    ];
    const rows = [
      row("p"),
      row("refund", { amountCents: -25 }),
      row("next", { date: "2026-02-01", amountCents: 999 }),
      row("pending", { pending: true, amountCents: 500 }),
      row("card", { accountId: "card", amountCents: 200 })
    ];
    const funding = await fundingAt(store, accounts, rows, "2026-01", "2026-02-15");
    expect(funding.map((a) => [a.accountId, a.balanceCents, a.asOf])).toEqual([
      ["cash", 9925, "2026-01-31"],
      ["card", 4200, "2026-01-31"]
    ]);
  });
  it("uses only recorded provider snapshots at or before month end and exposes missing history", async () => {
    const { store } = fixture();
    const accounts = [
      account("bank", { source: "provider" }),
      account("missing", { source: "provider" })
    ];
    await store.putSnapshotChunk("bank", "2026-01", { "2026-01-03": 1234, "2026-01-30": 2345 });
    await store.putSnapshotChunk("bank", "2026-02", { "2026-02-01": 9999 });
    const funding = await fundingAt(store, accounts, [], "2026-01", "2026-02-15");
    expect(funding.map((a) => [a.balanceCents, a.asOf])).toEqual([
      [2345, "2026-01-30"],
      [null, null]
    ]);
  });
  it("keeps mixed-currency and tracking activity out, reserves future plans and exposes pending separately", async () => {
    const { store, ports } = fixture();
    await store.putAccount(account("cash", { balanceCents: 10000 }));
    await store.putAccount(account("eur", { isoCurrency: "EUR", balanceCents: 999999 }));
    await store.putAccount(account("investment", { type: "investment", balanceCents: 999999 }));
    await store.putTransactionChunk("cash", "2026-02", [
      row("g", { date: "2026-02-10", amountCents: 200 }),
      row("p", { date: "2026-02-11", pending: true, amountCents: 900 })
    ]);
    await store.putTransactionChunk("eur", "2026-02", [
      row("e", { date: "2026-02-10", accountId: "eur", isoCurrency: "EUR", amountCents: 99999 })
    ]);
    await store.putTransactionChunk("investment", "2026-02", [
      row("i", { date: "2026-02-10", accountId: "investment", amountCents: 88888 })
    ]);
    await store.setAssignment("2026-02", "groceries", 1000);
    await store.setAssignment("2026-03", "groceries", 500);
    const context = await budgetContext(ports, store, "2026-02");
    expect(context).toMatchObject({
      isoCurrency: "USD",
      readyToAssignCents: 8700,
      futureReservedCents: 500,
      pendingCount: 1,
      excludedAccountCount: 2,
      state: { categories: { groceries: { activityCents: 200, availableCents: 800 } } }
    });
    expect(await budgetContext(ports, store, "2026-03")).toMatchObject({
      readyToAssignCents: null,
      readyUnavailable: "future_month"
    });
  });
  it("makes historical ready-to-assign unavailable when one provider valuation is missing", async () => {
    const { store, ports } = fixture();
    await store.putAccount(account("bank", { source: "provider", balanceCents: 999999 }));
    expect(await budgetContext(ports, store, "2026-01")).toMatchObject({
      readyToAssignCents: null,
      readyUnavailable: "missing_history"
    });
  });
  it("does not pair a budget inflow against a tracking outflow", async () => {
    const { store, ports } = fixture();
    await store.putAccount(account("cash"));
    await store.putAccount(account("tracking", { type: "investment" }));
    await store.putTransactionChunk("cash", "2026-02", [
      row("in", { date: "2026-02-01", categoryId: "income", amountCents: -100 })
    ]);
    await store.putTransactionChunk("tracking", "2026-02", [
      row("out", {
        date: "2026-02-01",
        accountId: "tracking",
        categoryId: "transfers",
        amountCents: 100
      })
    ]);
    expect(await budgetContext(ports, store, "2026-02")).toMatchObject({
      state: { tbbCents: 100 }
    });
  });
  it("uses Moss timezone at year and month boundaries", async () => {
    const { store, ports } = fixture();
    const local = {
      ...ports,
      now: () => new Date("2027-01-01T01:00:00Z"),
      localTimezone: "America/Los_Angeles"
    };
    await store.putAccount(account("cash"));
    expect(await budgetContext(local, store, "2026-12")).toMatchObject({
      currentMonth: "2026-12",
      readyUnavailable: null
    });
    expect(await budgetContext(local, store, "2027-01")).toMatchObject({
      readyUnavailable: "future_month"
    });
  });
  it("handles leap-day month ends and rejects an unsafe reconstructed balance", async () => {
    const { store } = fixture();
    expect(await fundingAt(store, [account("cash")], [], "2024-02", "2026-02-15")).toEqual([]);
    const early = account("cash", { openingDate: "2024-01-01" });
    expect((await fundingAt(store, [early], [], "2024-02", "2026-02-15"))[0]?.asOf).toBe(
      "2024-02-29"
    );
    await expect(
      fundingAt(
        store,
        [account("cash", { openingBalanceCents: Number.MAX_SAFE_INTEGER })],
        [row("in", { amountCents: -1 })],
        "2026-01",
        "2026-02-15"
      )
    ).rejects.toThrow();
  });
});
