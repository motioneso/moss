import { describe, expect, it } from "vitest";
import {
  deriveCardReserves,
  cardReadyToAssignCents,
  allocateCardCents
} from "../../external-modules/finance/src/domain/card-reserves.js";
import { deriveBudgetMonths } from "../../external-modules/finance/src/domain/envelope.js";
import { readyToAssignCents } from "../../external-modules/finance/src/domain/ready-to-assign.js";
import { splitsBalance } from "../../external-modules/finance/src/domain/splits.js";
import { effectiveTransferIds } from "../../external-modules/finance/src/domain/transfers.js";
import { FLEX_POOL } from "../../external-modules/finance/src/domain/flex.js";
import type { FlexPolicy } from "../../external-modules/finance/src/domain/flex.js";
import type {
  AccountRecord,
  TransactionRecord
} from "../../external-modules/finance/src/domain/records.js";
const card = (id = "card", opening = 50000): AccountRecord => ({
  accountId: id,
  itemId: null,
  source: "manual",
  openingDate: "2026-01-01",
  openingBalanceCents: opening,
  name: id,
  officialName: null,
  type: "credit",
  subtype: "credit card",
  mask: null,
  balanceCents: opening,
  isoCurrency: "USD",
  updatedAt: "2026-10-30T00:00:00Z"
});
const cash: AccountRecord = { ...card("cash", 100000), type: "depository", subtype: "checking" };
const row = (
  id: string,
  amount: number,
  overrides: Partial<TransactionRecord> = {}
): TransactionRecord => ({
  id,
  accountId: "card",
  date: "2026-10-10",
  amountCents: amount,
  isoCurrency: "USD",
  name: "Synthetic entry",
  merchant: null,
  plaidCategory: null,
  categoryId: "food",
  pending: false,
  pendingTransactionId: null,
  categorizedBy: "user",
  source: "manual",
  ...overrides
});
function derive(
  rows: TransactionRecord[],
  options: {
    cards?: AccountRecord[];
    assigned?: number;
    ledgers?: Record<string, { assignments: Record<string, number> }>;
    flexPolicies?: FlexPolicy[];
    month?: string;
    effectiveMonth?: string;
  } = {}
) {
  const cards = options.cards ?? [card()];
  const accounts = [cash, ...cards];
  const month = options.month ?? "2026-10";
  const excluded = effectiveTransferIds(rows);
  const transactionsByMonth: Record<string, TransactionRecord[]> = {};
  for (const r of rows)
    if (!r.pending && !excluded.has(r.id)) (transactionsByMonth[r.date.slice(0, 7)] ??= []).push(r);
  const ordinary = deriveBudgetMonths({
    ledgers: { "2026-10": { assignments: {} }, [month]: { assignments: {} }, ...options.ledgers },
    transactionsByMonth,
    flexPolicies: options.flexPolicies
  });
  const states = deriveCardReserves({
    accounts,
    rows,
    policies: cards.map((c) => ({
      accountId: c.accountId,
      effectiveMonth: options.effectiveMonth ?? "2026-10"
    })),
    assignments: [
      { accountId: cards[0]!.accountId, month: "2026-10", assignedCents: options.assigned ?? 10000 }
    ],
    ordinary,
    flexPolicies: options.flexPolicies,
    through: "2026-12-31"
  });
  const balances = accounts.map((a) => ({
    ...a,
    balanceCents:
      a.openingBalanceCents! +
      rows
        .filter((r) => r.accountId === a.accountId && !r.pending && r.date.slice(0, 7) <= month)
        .reduce((sum, r) => sum + (a.type === "credit" ? r.amountCents : -r.amountCents), 0)
  }));
  return {
    states,
    cards: states[month]!,
    ordinary: ordinary[month]!,
    ready: cardReadyToAssignCents(balances, ordinary[month]!, states[month]!),
    balances
  };
}
const payment = (amount: number, date = "2026-10-15") => [
  row(`pay-card-${date}`, -amount, { date, transferId: `pay-${date}`, categoryId: "transfers" }),
  row(`pay-cash-${date}`, amount, {
    accountId: "cash",
    date,
    transferId: `pay-${date}`,
    categoryId: "transfers"
  })
];

describe("manual card payment reserves", () => {
  it("keeps legacy debt netting until explicit enrollment and preserves older months", () => {
    const d = derive([], { month: "2026-09", ledgers: { "2026-09": { assignments: {} } } });
    expect(d.cards).toEqual([]);
    expect(d.ready).toBe(50000);
    expect(d.ready).toBe(readyToAssignCents(d.balances, d.ordinary.categories));
    expect(derive([]).ready).toBe(90000);
    expect(derive([]).cards[0]).toMatchObject({
      owedCents: 50000,
      availableCents: 10000,
      startingDebtCents: 50000
    });
  });
  it("moves funded purchases from their envelope to payment cash and consumes recorded payments", () => {
    const d = derive([row("buy", 5000), ...payment(10000)], {
      ledgers: { "2026-10": { assignments: { food: 10000 } } }
    });
    expect(d.cards[0]).toMatchObject({
      owedCents: 45000,
      fundedCents: 5000,
      paymentsCents: 10000,
      availableCents: 5000,
      unfundedCents: 0
    });
    expect(d.ordinary.categories.food!.availableCents).toBe(5000);
    expect(d.ready).toBe(80000);
  });
  it.each([0, 2500, 5000])(
    "never turns underfunded credit spending into Ready (funding %i)",
    (funding) => {
      const d = derive([row("buy", 10000)], {
        assigned: 0,
        ledgers: { "2026-10": { assignments: { food: funding } } }
      });
      expect(d.cards[0]).toMatchObject({ fundedCents: funding, unfundedCents: 10000 - funding });
      expect(d.ready).toBe(100000 - funding);
    }
  );
  it("gives cash spending first claim on a category's limited money", () => {
    const d = derive([row("buy-card", 10000), row("buy-cash", 8000, { accountId: "cash" })], {
      assigned: 0,
      ledgers: { "2026-10": { assignments: { food: 12000 } } }
    });
    expect(d.cards[0]).toMatchObject({ fundedCents: 4000, unfundedCents: 6000 });
    expect(d.ready).toBe(88000);
  });
  it("returns refunds to their category and shows negative payment cash after that money was used", () => {
    const d = derive([row("refund", -5000)], { assigned: 0 });
    expect(d.cards[0]).toMatchObject({
      refundsCents: -5000,
      availableCents: -5000,
      owedCents: 45000
    });
    expect(d.ordinary.categories.food!.availableCents).toBe(5000);
    expect(d.ready).toBe(100000);
    const next = derive([row("refund", -5000)], { assigned: 0, month: "2026-11" });
    expect(next.cards[0]!.availableCents).toBe(0);
    expect(next.ready).toBe(95000);
  });
  it("does not silently release reserves for a statement credit or uncategorized debt", () => {
    const d = derive([
      row("credit", -5000, { categoryId: "income" }),
      row("unknown", 2000, { categoryId: null })
    ]);
    expect(d.cards[0]).toMatchObject({
      owedCents: 47000,
      availableCents: 10000,
      fundedCents: 0,
      refundsCents: 0,
      unfundedCents: 0
    });
    expect(d.ready).toBe(90000);
  });
  it("funds only the debt portion of spending across a positive card balance", () => {
    const d = derive([row("cross-zero", 15000)], {
      cards: [card("card", -10000)],
      assigned: 0,
      ledgers: { "2026-10": { assignments: { food: 15000 } } }
    });
    expect(d.cards[0]).toMatchObject({ owedCents: 5000, fundedCents: 5000, availableCents: 5000 });
    expect(d.ready).toBe(95000);
  });
  it("records the entire payment including an overpayment and its inverse correction", () => {
    const over = derive(payment(60000), { assigned: 50000 });
    expect(over.cards[0]).toMatchObject({
      owedCents: 0,
      paymentsCents: 60000,
      availableCents: -10000
    });
    expect(over.ready).toBe(60000);
    const reversed = derive([...payment(60000), ...payment(-60000, "2026-10-16")], {
      assigned: 50000
    });
    expect(reversed.cards[0]).toMatchObject({
      owedCents: 50000,
      paymentsCents: 0,
      availableCents: 50000
    });
    expect(reversed.ready).toBe(50000);
  });
  it("carries positive reserves and drops the credit overspending adjustment next month", () => {
    const d = derive([row("buy", 10000)], {
      assigned: 0,
      month: "2026-11",
      ledgers: { "2026-10": { assignments: { food: 2500 } } }
    });
    expect(d.cards[0]).toMatchObject({
      availableCents: 2500,
      unfundedCents: 0,
      fundedCents: 0,
      owedCents: 60000
    });
    expect(d.ready).toBe(97500);
  });
  it("shares underfunded cash proportionally between cards, rounding deterministic cents", () => {
    const d = derive([row("a", 3), row("b", 3, { accountId: "other" })], {
      assigned: 0,
      cards: [card(), card("other")],
      ledgers: { "2026-10": { assignments: { food: 3 } } }
    });
    expect(d.cards.map((c) => c.fundedCents)).toEqual([2, 1]);
    expect(d.ready).toBe(99997);
  });
  it("uses the shared flexible pool instead of duplicating member funding", () => {
    const d = derive([row("a", 5000), row("b", 5000, { categoryId: "fun" })], {
      assigned: 0,
      flexPolicies: [
        { month: "2026-10", active: true, flexIds: ["food", "fun"], nonMonthlyIds: [] }
      ],
      ledgers: { "2026-10": { assignments: { food: 5000 } } }
    });
    expect(d.ordinary.categories[FLEX_POOL]!.availableCents).toBe(-5000);
    expect(d.cards[0]).toMatchObject({ fundedCents: 5000, unfundedCents: 5000 });
    expect(d.ready).toBe(95000);
  });
  it("excludes pending activity and future rows", () => {
    const d = derive([
      row("pending", 5000, { pending: true }),
      row("future", 5000, { date: "2027-01-01" })
    ]);
    expect(d.cards[0]).toMatchObject({ owedCents: 50000, availableCents: 10000, fundedCents: 0 });
  });
  it("requires complete explicit manual transfer pairs, including on later reads", () => {
    expect(() => derive([row("unlinked", -5000, { categoryId: "transfers" })])).toThrow(/unlinked/);
    expect(() => derive(payment(5000).slice(0, 1))).toThrow(/unlinked/);
    expect(() => derive(payment(5000).map((r) => ({ ...r, amountCents: 1 })))).toThrow(/unlinked/);
  });
  it("does not reject legacy unlinked transfers dated before enrollment", () => {
    const d = derive([row("legacy", -5000, { date: "2026-09-10", categoryId: "transfers" })]);
    expect(d.cards[0]!.startingDebtCents).toBe(45000);
  });
  it("supports leap-day historical movement and resets negative carry across gaps", () => {
    const d = derive([row("refund", -5000, { date: "2024-02-29" })], {
      effectiveMonth: "2024-02",
      assigned: 0,
      month: "2024-04",
      cards: [{ ...card(), openingDate: "2024-01-01" }]
    });
    expect(d.cards[0]).toMatchObject({ owedCents: 45000, availableCents: 0 });
    expect(d.ready).toBe(95000);
  });
  it("rejects unsafe balances instead of rounding", () => {
    expect(() =>
      derive([row("overflow", 1)], { cards: [card("card", Number.MAX_SAFE_INTEGER)] })
    ).toThrow(/safe integer/);
  });
  it("preserves exact signed split allocations despite unsafe intermediate cancellation", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(
      splitsBalance({
        amountCents: max,
        splits: [
          { categoryId: "a", amountCents: max },
          { categoryId: "b", amountCents: max },
          { categoryId: "c", amountCents: -max }
        ]
      })
    ).toBe(true);
    expect(allocateCardCents([max, max, -max], max, max)).toEqual([max, max, -max]);
    expect(allocateCardCents([101, -1], 50, 100)).toEqual([50, 0]);
    expect(allocateCardCents([-101, 1], -50, -100)).toEqual([-50, 0]);
  });
  it("conserves cents across generated cash, credit and refund combinations", () => {
    let seed = 721;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed % 20000;
    };
    for (let i = 0; i < 500; i++) {
      const credit = random(),
        paidCash = random(),
        funding = random(),
        reserved = random();
      const refund = -(random() % 5000);
      const d = derive(
        [row("a", credit), row("b", paidCash, { accountId: "cash" }), row("c", refund)],
        {
          assigned: reserved,
          ledgers: { "2026-10": { assignments: { food: funding } } }
        }
      );
      const envelopes = Object.values(d.ordinary.categories).reduce(
        (s, c) => s + c.availableCents,
        0
      );
      const reserves = d.cards.reduce((s, c) => s + c.availableCents + c.unfundedCents, 0);
      expect(d.ready + envelopes + reserves).toBe(100000 - paidCash);
      expect(d.ready).toBe(100000 - reserved - funding);
    }
  });
});
