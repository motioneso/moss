import { describe, expect, it, vi } from "vitest";
import {
  billCreateHandler,
  billDecideHandler,
  billsReadHandler
} from "../../external-modules/finance/src/worker/handlers/bills.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { BillPlan } from "../../external-modules/finance/src/domain/bills.js";
const tokens = { expectedRevision: 1, expectedFingerprint: "a".repeat(32) };
const plan: BillPlan = {
  id: "94bfda66-d527-4b21-8f42-11dfe10408db",
  name: "Synthetic bill",
  accountId: "cash",
  categoryId: "utilities",
  isoCurrency: "USD",
  amountCents: 100,
  anchorDate: "2026-01-31",
  cadence: "monthly"
};
function fixture() {
  const bills = {
    plans: async () => [plan],
    decisions: async () => [
      {
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "matched",
        transactionId: "earlier-month",
        actualCents: 103,
        matchedValid: true
      }
    ],
    decide: vi.fn(async () => true),
    create: vi.fn(async () => true)
  };
  const policy = {
    get: async () => ({
      revision: 1,
      fingerprint: "a".repeat(32),
      isoCurrency: "USD",
      taxonomyReady: true
    }),
    categories: async () => []
  };
  const store = {
    bills,
    budgetPolicy: policy,
    listAccounts: async () => [],
    listTransactionMonths: async () => [],
    listMonthTransactions: async () => []
  };
  const ports = {
    store: async () => store,
    now: () => new Date("2026-02-28T00:00:00Z"),
    localTimezone: "UTC"
  } as unknown as WorkerPorts;
  return { ports, bills, store };
}
describe("reviewed bill handler validation", () => {
  it("rejects a non-occurrence rather than recording an arbitrary due date", async () => {
    const f = fixture();
    await expect(
      billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-27",
        state: "skipped"
      })
    ).rejects.toThrow();
    expect(f.bills.decide).not.toHaveBeenCalled();
  });
  it("accepts a clamped occurrence and requires a transaction only for matching", async () => {
    const f = fixture();
    await expect(
      billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "matched"
      })
    ).rejects.toThrow();
    expect(
      await billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "skipped"
      })
    ).toMatchObject({ status: "ok" });
  });
  it("rejects stale and malformed monetary reviews before writing", async () => {
    const f = fixture();
    const input = {
      ...tokens,
      id: plan.id,
      name: plan.name,
      accountId: "cash",
      categoryId: "utilities",
      amountCents: 100,
      anchorDate: "2026-02-28",
      cadence: "monthly"
    };
    await expect(billCreateHandler(f.ports)({ ...input, expectedRevision: 0 })).rejects.toThrow();
    await expect(billCreateHandler(f.ports)({ ...input, amountCents: 1.5 })).rejects.toThrow();
    await expect(
      billCreateHandler(f.ports)({ ...input, anchorDate: "2026-02-30" })
    ).rejects.toThrow();
    expect(f.bills.create).not.toHaveBeenCalled();
  });
  it("rejects an excessive projection even when there are no bills", async () => {
    const f = fixture();
    await expect(
      billsReadHandler(f.ports)({ from: "2026-01-01", to: "2028-01-01" })
    ).rejects.toThrow();
  });

  it("reads as setup required, not an error, before a budget currency is chosen", async () => {
    const f = fixture();
    f.store.budgetPolicy.get = async () => null as never;
    const plans = vi.spyOn(f.bills, "plans");
    await expect(
      billsReadHandler(f.ports)({ from: "2026-02-01", to: "2026-02-28" })
    ).resolves.toEqual({ status: "ok", setupRequired: true });
    expect(plans).not.toHaveBeenCalled();
  });
});

describe("bill match candidates across month boundaries", () => {
  it("reads boundary partitions missing from the index, retaining only eligible unclaimed expenses", async () => {
    const f = fixture();
    const expense = (id: string, date: string, overrides = {}) => ({
      id,
      date,
      accountId: "cash",
      name: "Synthetic utility",
      amountCents: 100,
      pending: false,
      isoCurrency: "USD",
      categoryId: "utilities",
      ...overrides
    });
    const rows = [
      expense("first", "2025-12-25"),
      expense("before", "2025-12-24"),
      expense("early", "2025-12-31"),
      expense("current", "2026-01-31"),
      expense("late", "2026-02-07"),
      expense("after", "2026-02-08"),
      expense("pending", "2026-01-01", { pending: true }),
      expense("refund", "2026-01-01", { amountCents: -100 }),
      expense("other-currency", "2026-01-01", { isoCurrency: "EUR" }),
      expense("transfer", "2026-01-01", { categoryId: "transfers" }),
      expense("income", "2026-01-01", { categoryId: "income" }),
      expense("claimed", "2025-12-30")
    ];
    const readMonth = vi.fn(async (month: string) => rows.filter((t) => t.date.startsWith(month)));
    Object.assign(f.store, {
      listTransactionMonths: async () => [],
      listMonthTransactions: readMonth,
      billAdjustments: { rows: async () => [], claimedTransactionIds: async () => ["claimed"] }
    });
    const result = await billsReadHandler(f.ports)({ from: "2026-01-01", to: "2026-01-31" });
    expect(result).toMatchObject({ matchFrom: "2025-12-25", matchTo: "2026-02-07" });
    expect((result.transactions as { id: string }[]).map((t) => t.id)).toEqual([
      "first",
      "early",
      "current",
      "late"
    ]);
    expect(readMonth.mock.calls.map(([month]) => month)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(result.occurrences).toEqual(
      expect.arrayContaining([expect.objectContaining({ dueDate: "2026-01-31" })])
    );
  });
  it("retains the bounded candidate limit after the window expands", async () => {
    const f = fixture();
    Object.assign(f.store, {
      listMonthTransactions: async () =>
        Array.from({ length: 1001 }, (_, i) => ({
          id: String(i),
          date: "2026-01-31",
          accountId: "cash",
          name: "Synthetic",
          amountCents: 1,
          pending: false,
          isoCurrency: "USD",
          categoryId: "utilities"
        }))
    });
    await expect(
      billsReadHandler(f.ports)({ from: "2026-01-01", to: "2026-01-31" })
    ).rejects.toThrow("shorter window");
  });
});
