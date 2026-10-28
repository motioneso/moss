// tests/unit/external-module-finance-envelope.test.ts
import { describe, expect, it } from "vitest";

import {
  deriveBudgetMonths,
  type BudgetLedger
} from "../../external-modules/finance/src/domain/envelope.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";

// FIN-03 (#1148) Task 1: the envelope math contract (spec delta §"Envelope
// math"). These are YNAB semantics pinned as numbers: positive available
// rolls forward, cash overspend debits the NEXT month's TBB instead of
// haunting the category, transfers never count as activity, pending rows do.
// The function is pure — every handler/cache behavior layers on top of it,
// so a wrong number here is wrong everywhere.

let txnSeq = 0;
function txn(partial: Partial<TransactionRecord> & { amountCents: number }): TransactionRecord {
  txnSeq += 1;
  return {
    id: `tx-${txnSeq}`,
    accountId: "acc1",
    date: "2026-07-15",
    isoCurrency: "USD",
    name: "FIXTURE",
    merchant: null,
    plaidCategory: null,
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    ...partial
  };
}

const ledger = (assignments: Record<string, number>): BudgetLedger => ({ assignments });

describe("finance envelope math (#1148)", () => {
  it("derives a single month: available = assigned − activity, tbb = income − assigned", () => {
    const result = deriveBudgetMonths({
      ledgers: { "2026-07": ledger({ groceries: 50_000 }) },
      transactionsByMonth: {
        "2026-07": [
          txn({ categoryId: "income", amountCents: -200_000 }),
          txn({ categoryId: "groceries", amountCents: 12_345 })
        ]
      }
    });

    expect(result["2026-07"]).toEqual({
      tbbCents: 200_000 - 50_000,
      categories: {
        // Income appears as a category row too (spec formula excludes only
        // transfers from activity); its inflow-negative activity never
        // reaches overspend because available stays positive.
        income: { assignedCents: 0, activityCents: -200_000, availableCents: 200_000 },
        groceries: { assignedCents: 50_000, activityCents: 12_345, availableCents: 37_655 }
      }
    });
  });

  it("rolls only positive available forward as next month's carry", () => {
    const result = deriveBudgetMonths({
      ledgers: {
        "2026-06": ledger({ groceries: 30_000 }),
        "2026-07": ledger({ groceries: 10_000 })
      },
      transactionsByMonth: {
        "2026-06": [txn({ categoryId: "groceries", amountCents: 25_000, date: "2026-06-10" })],
        "2026-07": [txn({ categoryId: "groceries", amountCents: 4_000, date: "2026-07-10" })]
      }
    });

    // June leaves 5_000; July = 5_000 carry + 10_000 assigned − 4_000 spent.
    expect(result["2026-07"]!.categories.groceries).toEqual({
      assignedCents: 10_000,
      activityCents: 4_000,
      availableCents: 11_000
    });
  });

  it("cash overspend resets the category and debits the NEXT month's TBB", () => {
    const result = deriveBudgetMonths({
      ledgers: {
        "2026-06": ledger({ dining: 10_000 }),
        "2026-07": ledger({ dining: 10_000 })
      },
      transactionsByMonth: {
        "2026-06": [
          txn({ categoryId: "income", amountCents: -100_000, date: "2026-06-01" }),
          txn({ categoryId: "dining", amountCents: 15_000, date: "2026-06-20" })
        ],
        "2026-07": []
      }
    });

    // June: dining overspent by 5_000 → available −5_000, shown in-month.
    expect(result["2026-06"]!.categories.dining!.availableCents).toBe(-5_000);
    expect(result["2026-06"]!.tbbCents).toBe(100_000 - 10_000);
    // July: the category starts clean (carry = max(−5_000, 0) = 0)…
    expect(result["2026-07"]!.categories.dining).toEqual({
      assignedCents: 10_000,
      activityCents: 0,
      availableCents: 10_000
    });
    // …and the 5_000 debits TBB instead: 100_000 − 20_000 assigned − 5_000.
    expect(result["2026-07"]!.tbbCents).toBe(100_000 - 20_000 - 5_000);
  });

  it("accumulates TBB across three months (income, assigned, prior overspend)", () => {
    const result = deriveBudgetMonths({
      ledgers: {
        "2026-05": ledger({ everyday: 40_000 }),
        "2026-06": ledger({ everyday: 40_000 }),
        "2026-07": ledger({ everyday: 40_000 })
      },
      transactionsByMonth: {
        "2026-05": [
          txn({ categoryId: "income", amountCents: -300_000, date: "2026-05-01" }),
          txn({ categoryId: "everyday", amountCents: 50_000, date: "2026-05-15" })
        ],
        "2026-06": [txn({ categoryId: "income", amountCents: -300_000, date: "2026-06-01" })],
        "2026-07": []
      }
    });

    // May: 300k in − 40k assigned; the 10k overspend hits from June on.
    expect(result["2026-05"]!.tbbCents).toBe(260_000);
    expect(result["2026-06"]!.tbbCents).toBe(600_000 - 80_000 - 10_000);
    expect(result["2026-07"]!.tbbCents).toBe(600_000 - 120_000 - 10_000);
  });

  it("excludes transfers from activity entirely", () => {
    const result = deriveBudgetMonths({
      ledgers: { "2026-07": ledger({ groceries: 10_000 }) },
      transactionsByMonth: {
        "2026-07": [
          txn({ categoryId: "transfers", amountCents: 50_000 }),
          txn({ categoryId: "transfers", amountCents: -50_000 }),
          txn({ categoryId: "groceries", amountCents: 2_000 })
        ]
      }
    });

    expect(result["2026-07"]!.categories.transfers).toBeUndefined();
    expect(result["2026-07"]!.categories.groceries!.activityCents).toBe(2_000);
    expect(result["2026-07"]!.tbbCents).toBe(-10_000);
  });

  it("includes pending transactions in activity", () => {
    const result = deriveBudgetMonths({
      ledgers: { "2026-07": ledger({ dining: 5_000 }) },
      transactionsByMonth: {
        "2026-07": [
          txn({ categoryId: "dining", amountCents: 1_500, pending: true }),
          txn({ categoryId: "dining", amountCents: 2_000 })
        ]
      }
    });

    expect(result["2026-07"]!.categories.dining).toEqual({
      assignedCents: 5_000,
      activityCents: 3_500,
      availableCents: 1_500
    });
  });

  it("treats ledger values as set totals, not increments", () => {
    // The ledger stores the assignment TOTAL for category+month (replay-safe
    // for retryLimit 1) — deriving must surface it verbatim, never summed
    // with carry or with any earlier value.
    const result = deriveBudgetMonths({
      ledgers: { "2026-07": ledger({ groceries: 7_777 }) },
      transactionsByMonth: {}
    });
    expect(result["2026-07"]!.categories.groceries!.assignedCents).toBe(7_777);
  });

  it("derives future ledger-only months with zero activity", () => {
    const result = deriveBudgetMonths({
      ledgers: {
        "2026-07": ledger({ savings: 20_000 }),
        "2026-09": ledger({ savings: 20_000 })
      },
      transactionsByMonth: {
        "2026-07": [txn({ categoryId: "income", amountCents: -100_000 })]
      }
    });

    // 2026-08 has no data — not derived; carry passes through unchanged.
    expect(result["2026-08"]).toBeUndefined();
    expect(result["2026-09"]!.categories.savings).toEqual({
      assignedCents: 20_000,
      activityCents: 0,
      availableCents: 40_000
    });
    expect(result["2026-09"]!.tbbCents).toBe(100_000 - 40_000);
  });

  it("is deterministic — same inputs, deep-equal output, no clock", () => {
    const input = {
      ledgers: { "2026-07": ledger({ groceries: 10_000 }) },
      transactionsByMonth: {
        "2026-07": [txn({ categoryId: "groceries", amountCents: 3_000 })]
      }
    };
    expect(deriveBudgetMonths(input)).toEqual(deriveBudgetMonths(input));
  });
});

describe("exact envelope boundaries", () => {
  it("keeps a cent through cancelling large activity instead of rounding an intermediate sum", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const input = {
      ledgers: { "2026-07": ledger({ groceries: 10 }) },
      transactionsByMonth: {
        "2026-07": [maximum, 2, -maximum].map((amountCents) =>
          txn({ categoryId: "groceries", amountCents })
        )
      }
    };
    const category = deriveBudgetMonths(input)["2026-07"]!.categories.groceries!;
    expect(category).toEqual({ assignedCents: 10, activityCents: 2, availableCents: 8 });
    input.transactionsByMonth["2026-07"].reverse();
    expect(deriveBudgetMonths(input)["2026-07"]!.categories.groceries).toEqual(category);
  });
  it("rejects unsafe public activity or carry, and validates every source amount", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(() =>
      deriveBudgetMonths({
        ledgers: {},
        transactionsByMonth: {
          "2026-07": [
            txn({ amountCents: maximum, categoryId: "groceries" }),
            txn({ amountCents: 1, categoryId: "groceries" })
          ]
        }
      })
    ).toThrow(/safe integer/);
    expect(() =>
      deriveBudgetMonths({
        ledgers: { "2026-12": ledger({ groceries: maximum }), "2027-02": ledger({ groceries: 1 }) },
        transactionsByMonth: {}
      })
    ).toThrow(/safe integer/);
    expect(() =>
      deriveBudgetMonths({
        ledgers: {},
        transactionsByMonth: { "2026-07": [txn({ amountCents: 1.5 })] }
      })
    ).toThrow(/safe integer/);
    expect(() =>
      deriveBudgetMonths({
        ledgers: { "2026-07": ledger({ groceries: 1.5 }) },
        transactionsByMonth: {}
      })
    ).toThrow(/safe integer/);
  });
});
