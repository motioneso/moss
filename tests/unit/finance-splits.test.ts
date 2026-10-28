import { describe, expect, it, vi } from "vitest";
import { allocations, splitsBalance } from "../../external-modules/finance/src/domain/splits.js";
import { aggregateSpending } from "../../external-modules/finance/src/domain/reports.js";
import { deriveBudgetMonths } from "../../external-modules/finance/src/domain/envelope.js";
import { reduceSyncPage, type PlaidTx } from "../../external-modules/finance/src/domain/reduce.js";
import { pairTransfers } from "../../external-modules/finance/src/domain/transfers.js";
import { splitApplyHandler } from "../../external-modules/finance/src/worker/handlers/split.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type {
  FinanceStore,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";

const row: TransactionRecord = {
  id: "synthetic",
  accountId: "cash",
  date: "2026-10-01",
  amountCents: 1001,
  isoCurrency: "USD",
  name: "Synthetic shop",
  merchant: null,
  plaidCategory: null,
  pending: false,
  pendingTransactionId: null,
  categoryId: null,
  categorizedBy: "user",
  reviewState: "confirmed",
  splitRevision: 1,
  splits: [
    { categoryId: "groceries", amountCents: 700 },
    { categoryId: "dining", amountCents: 301 }
  ]
};

describe("split ledger math", () => {
  it("allocates every cent once in budgets and reports", () => {
    const budget = deriveBudgetMonths({
      ledgers: { "2026-10": { assignments: { groceries: 1000, dining: 1000 } } },
      transactionsByMonth: { "2026-10": [row] }
    });
    expect(budget["2026-10"]!.categories.groceries!.availableCents).toBe(300);
    expect(budget["2026-10"]!.categories.dining!.availableCents).toBe(699);
    const [report] = aggregateSpending([row], ["2026-10"]);
    expect(report?.byCategory).toEqual({ groceries: 700, dining: 301 });
    expect(report?.cashFlow.outflowCents).toBe(1001);
  });
  it("nets refunds to their categories and carries remaining envelopes across a year boundary", () => {
    const refund = {
      ...row,
      date: "2027-01-01",
      amountCents: -1001,
      splits: row.splits!.map((p) => ({ ...p, amountCents: -p.amountCents }))
    };
    const result = deriveBudgetMonths({
      ledgers: { "2026-12": { assignments: { groceries: 1000 } } },
      transactionsByMonth: { "2027-01": [refund] }
    });
    expect(result["2027-01"]!.categories.groceries!.availableCents).toBe(1700);
    expect(aggregateSpending([refund], ["2027-01"])[0]?.cashFlow.outflowCents).toBe(-1001);
  });
  it("a changed bank total is counted once as uncategorized and retained splits need repair", () => {
    const changed = { ...row, amountCents: 1200 };
    expect(splitsBalance(changed)).toBe(false);
    expect(allocations(changed)).toEqual([{ categoryId: null, amountCents: 1200 }]);
    expect(aggregateSpending([changed], ["2026-10"])[0]?.byCategory).toEqual({
      uncategorized: 1200
    });
  });
  it("sync preserves allocations and flags a bank correction", () => {
    const incoming: PlaidTx = {
      transaction_id: row.id,
      account_id: row.accountId,
      date: row.date,
      amount: 12,
      iso_currency_code: "USD",
      name: row.name,
      merchant_name: null,
      personal_finance_category: null,
      pending: false,
      pending_transaction_id: null
    };
    const result = reduceSyncPage(
      { "cash:2026-10": { transactions: [row] } },
      { added: [], modified: [incoming], removed: [] }
    );
    expect(result.chunks["cash:2026-10"]!.transactions[0]).toMatchObject({
      amountCents: 1200,
      splits: row.splits,
      splitRevision: 1,
      reviewState: "needs_look"
    });
    expect(row.amountCents).toBe(1001);
  });
  it("does not infer a split purchase as a transfer", () => {
    expect(
      pairTransfers([
        row,
        {
          ...row,
          id: "other",
          accountId: "bank",
          amountCents: -1001,
          categoryId: "transfers",
          splits: undefined
        }
      ])
    ).toEqual([]);
  });
});

describe("split command validation", () => {
  function fixture(over: Partial<TransactionRecord> = {}, committed = true) {
    const save = vi.fn(async () => committed);
    const store = {
      supportsSplits: true,
      getTransactionChunk: async () => [{ ...row, ...over }],
      setTransactionSplits: save
    } as unknown as FinanceStore;
    const ports = {
      kv: { get: async () => null },
      store: async () => store
    } as unknown as WorkerPorts;
    const params = {
      transactionId: row.id,
      accountId: row.accountId,
      month: "2026-10",
      expectedAmountCents: 1001,
      expectedRevision: 1,
      categoryIds: ["groceries", "dining"],
      amountsCents: [501, 500]
    };
    return { save, params, handler: splitApplyHandler(ports) };
  }
  it("sends a valid edit once to the conditional storage commit", async () => {
    const { save, params, handler } = fixture();
    await expect(handler({ jobKind: "finance.split-apply", params })).resolves.toEqual({
      status: "ok",
      parts: 2
    });
    expect(save).toHaveBeenCalledOnce();
  });
  it.each([
    { amountsCents: [500, 500] },
    { categoryIds: ["transfers", "dining"] },
    { categoryIds: ["missing", "dining"] },
    { expectedRevision: 0 },
    { expectedAmountCents: 1002, amountsCents: [502, 500] },
    { month: "2026-13" }
  ])("rejects invalid or stale edits before writing: %s", async (over) => {
    const { save, params, handler } = fixture();
    await expect(
      handler({ jobKind: "finance.split-apply", params: { ...params, ...over } })
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it("refuses pending rows and a concurrent update", async () => {
    for (const [over, committed] of [
      [{ pending: true }, true],
      [{}, false]
    ] as const) {
      const { params, handler } = fixture(over, committed);
      await expect(handler({ jobKind: "finance.split-apply", params })).rejects.toThrow();
    }
  });
  it("replaying the same allocation does not write or duplicate activity", async () => {
    const { save, params, handler } = fixture();
    await handler({
      jobKind: "finance.split-apply",
      params: { ...params, expectedRevision: 0, amountsCents: [700, 301] }
    });
    expect(save).not.toHaveBeenCalled();
  });
});
