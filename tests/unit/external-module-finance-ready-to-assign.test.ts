import { describe, expect, it } from "vitest";

import {
  deriveBudgetMonths,
  readyToAssignCents,
  type TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";

// #3173: ready to assign = account balances, less card debt, less every
// category's available. Each case builds the balances the bank would show.

let seq = 0;
function tx(over: Partial<TransactionRecord> & { amountCents: number }): TransactionRecord {
  seq += 1;
  return {
    id: `t${seq}`,
    accountId: "checking",
    date: "2026-07-10",
    isoCurrency: "USD",
    name: "X",
    merchant: null,
    plaidCategory: null,
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    ...over
  };
}

const checking = (balanceCents: number) => ({ type: "depository", balanceCents });
const card = (owedCents: number) => ({ type: "credit", balanceCents: owedCents });

describe("readyToAssignCents (#3173)", () => {
  it("income lands in ready to assign and assigning moves it into a category", () => {
    const derived = deriveBudgetMonths({
      ledgers: { "2026-07": { assignments: { groceries: 30_000 } } },
      transactionsByMonth: { "2026-07": [tx({ categoryId: "income", amountCents: -200_000 })] }
    });
    const ready = readyToAssignCents([checking(200_000)], derived["2026-07"]!.categories);
    expect(ready).toBe(170_000);
  });

  it("carried-over money stays out of ready to assign in the next month", () => {
    const derived = deriveBudgetMonths({
      ledgers: {
        "2026-07": { assignments: { groceries: 30_000 } },
        "2026-08": { assignments: {} }
      },
      transactionsByMonth: {
        "2026-07": [
          tx({ categoryId: "income", amountCents: -200_000 }),
          tx({ categoryId: "groceries", amountCents: 10_000 })
        ]
      }
    });
    // Balance 1900.00; 200.00 carries in groceries.
    const august = readyToAssignCents([checking(190_000)], derived["2026-08"]!.categories);
    expect(august).toBe(170_000);
  });

  it("an overspent category comes out of the next month, not this one", () => {
    const derived = deriveBudgetMonths({
      ledgers: { "2026-07": { assignments: { dining: 20_000 } }, "2026-08": { assignments: {} } },
      transactionsByMonth: {
        "2026-07": [
          tx({ categoryId: "income", amountCents: -100_000 }),
          tx({ categoryId: "dining", amountCents: 25_000, date: "2026-07-12" })
        ]
      }
    });
    const balances = [checking(75_000)];
    expect(readyToAssignCents(balances, derived["2026-07"]!.categories)).toBe(80_000);
    expect(readyToAssignCents(balances, derived["2026-08"]!.categories)).toBe(75_000);
  });

  it("card spending leaves ready to assign unchanged and paying the card does too", () => {
    const income = tx({ categoryId: "income", amountCents: -100_000 });
    const ledgers = { "2026-07": { assignments: { groceries: 30_000 } } };
    const before = deriveBudgetMonths({ ledgers, transactionsByMonth: { "2026-07": [income] } });
    const readyBefore = readyToAssignCents([checking(100_000)], before["2026-07"]!.categories);

    const after = deriveBudgetMonths({
      ledgers,
      transactionsByMonth: {
        "2026-07": [income, tx({ accountId: "visa", categoryId: "groceries", amountCents: 12_000 })]
      }
    })["2026-07"]!.categories;
    expect(readyToAssignCents([checking(100_000), card(12_000)], after)).toBe(readyBefore);

    // Paying the card from checking: checking drops 120.00, the card owes nothing.
    expect(readyToAssignCents([checking(88_000), card(0)], after)).toBe(readyBefore);
  });
});
