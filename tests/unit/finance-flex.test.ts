import { describe, it, expect } from "vitest";
import { deriveBudgetMonths } from "../../external-modules/finance/src/domain/envelope.js";
import {
  FLEX_POOL,
  leaveFlexAssignments,
  type FlexPolicy
} from "../../external-modules/finance/src/domain/flex.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
const policy: FlexPolicy = {
  month: "2026-12",
  active: true,
  flexIds: ["groceries", "dining"],
  nonMonthlyIds: []
};
const tx = (
  id: string,
  month: string,
  categoryId: string,
  amountCents: number
): TransactionRecord => ({
  id,
  accountId: "cash",
  date: `${month}-15`,
  name: "Synthetic",
  isoCurrency: "USD",
  amountCents,
  categoryId,
  pending: false,
  pendingTransactionId: null,
  categorizedBy: "user",
  merchant: null,
  plaidCategory: null
});
describe("cash-backed flexible pool conservation", () => {
  it("counts original assignment guidance and activity once, including split refunds", () => {
    const input = {
      ledgers: {
        "2026-12": { assignments: { groceries: 10000, dining: 5000, [FLEX_POOL]: 2000 } }
      },
      transactionsByMonth: {
        "2026-12": [
          tx("a", "2026-12", "groceries", 2000),
          {
            ...tx("b", "2026-12", "dining", 1000),
            splits: [
              { categoryId: "groceries", amountCents: 600 },
              { categoryId: "dining", amountCents: 400 }
            ]
          },
          tx("r", "2026-12", "dining", -300)
        ]
      },
      flexPolicies: [policy]
    };
    const state = deriveBudgetMonths(input)["2026-12"]!;
    expect(state.categories[FLEX_POOL]).toEqual({
      assignedCents: 17000,
      activityCents: 2700,
      availableCents: 14300
    });
    expect(state.categories.groceries).toBeUndefined();
    expect(state.categories.dining).toBeUndefined();
  });
  it("routes incoming carry once across gaps and year end", () => {
    const states = deriveBudgetMonths({
      ledgers: {
        "2026-10": { assignments: { groceries: 100, dining: 50 } },
        "2026-12": { assignments: { groceries: 20 } },
        "2027-01": { assignments: {} }
      },
      transactionsByMonth: {},
      flexPolicies: [policy]
    });
    expect(states["2026-10"]!.categories.groceries!.availableCents).toBe(100);
    expect(states["2026-12"]!.categories[FLEX_POOL]!.availableCents).toBe(170);
    expect(states["2027-01"]!.categories[FLEX_POOL]!.availableCents).toBe(170);
  });
  it("covers member overspending inside a positive pool while preserving signed totals", () => {
    const states = deriveBudgetMonths({
      ledgers: { "2026-12": { assignments: { dining: 1000 } } },
      transactionsByMonth: { "2026-12": [tx("a", "2026-12", "groceries", 200)] },
      flexPolicies: [policy]
    });
    expect(states["2026-12"]!.categories[FLEX_POOL]).toMatchObject({
      assignedCents: 1000,
      activityCents: 200,
      availableCents: 800
    });
  });
  it("leaves flex with an explicit distribution without restoring guidance twice", () => {
    const ledgers = {
      "2026-12": { assignments: { groceries: 100, dining: 50, [FLEX_POOL]: 20 } },
      "2027-01": { assignments: { groceries: 40, dining: 10, [FLEX_POOL]: 30 } }
    };
    const transactionsByMonth = { "2027-01": [tx("a", "2027-01", "groceries", 25)] };
    const active = { ...policy, month: "2026-12" };
    const off = { ...policy, month: "2027-01", active: false, flexIds: [] };
    const pooled = deriveBudgetMonths({ ledgers, transactionsByMonth, flexPolicies: [active] })[
      "2027-01"
    ]!;
    const envelope = deriveBudgetMonths({
      ledgers,
      transactionsByMonth,
      flexPolicies: [active, off]
    })["2027-01"]!;
    const available = pooled.categories[FLEX_POOL]!.availableCents;
    const assignments = leaveFlexAssignments(
      active.flexIds,
      { groceries: 200, dining: available - 200 },
      envelope.categories,
      available
    );
    const final = deriveBudgetMonths({
      ledgers: {
        ...ledgers,
        "2027-01": {
          assignments: {
            ...ledgers["2027-01"].assignments,
            ...Object.fromEntries(assignments.map((a) => [a.categoryId, a.amountCents]))
          }
        }
      },
      transactionsByMonth,
      flexPolicies: [active, off]
    })["2027-01"]!;
    expect(final.categories.groceries!.availableCents).toBe(200);
    expect(final.categories.dining!.availableCents).toBe(available - 200);
    expect(final.categories[FLEX_POOL]!.availableCents).toBe(0);
    expect(assignments.reduce((n, a) => n + a.amountCents, 0)).toBe(80);
    expect(final.tbbCents).toBe(pooled.tbbCents);
  });
  it("rejects missing or negative destinations and overflow", () => {
    expect(() => leaveFlexAssignments(["a"], {}, {}, 100)).toThrow();
    expect(() => leaveFlexAssignments(["a"], { a: -1 }, {}, -1)).toThrow();
    expect(() =>
      deriveBudgetMonths({
        ledgers: { "2026-12": { assignments: { groceries: Number.MAX_SAFE_INTEGER, dining: 1 } } },
        transactionsByMonth: {},
        flexPolicies: [policy]
      })
    ).toThrow();
  });
});
