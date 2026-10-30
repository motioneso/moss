import { FLEX_POOL, flexForMonth, routeFlexAmounts, type FlexPolicy } from "./flex.js";
// external-modules/finance/src/domain/envelope.ts
//
// FIN-03 (#1148) Task 1: pure YNAB-semantics budget derivation (spec delta
// §"Envelope math"). Everything here is a deterministic function of the
// assignment ledgers and transaction records — no clock, no I/O.
// Spending-positive integer cents throughout (FIN-01 record convention).

import type { TransactionRecord } from "./records.js";
import { safeCents } from "./values.js";
import { allocations } from "./splits.js";

/** `ledger:{YYYY-MM}` value — the assignment SOURCE OF TRUTH. Values are
 *  set totals per category+month (assign sets, never increments), which is
 *  what makes the budget-apply queue replay-safe at retryLimit 1. */
export type BudgetLedger = { assignments: Record<string, number> };

export type BudgetCategoryState = {
  assignedCents: number;
  /** Spending-positive; inflows (income) are negative. */
  activityCents: number;
  availableCents: number;
};

/** The pure derivation output; the handler stamps `computedAt` on top. */
export type BudgetMonthStateCore = {
  tbbCents: number;
  categories: Record<string, BudgetCategoryState>;
};

/** Derived month state returned by budget.status — computed fresh on every
 *  call, never persisted (FIN-06c F6-D1). */
export type BudgetMonthState = BudgetMonthStateCore & {
  /** ISO, from the worker ctx clock — never derived here (no ambient dates). */
  computedAt: string;
};

export type BudgetDerivationInput = {
  /** YYYY-MM → assignment ledger. */
  flexPolicies?: readonly FlexPolicy[];
  ledgers: Record<string, BudgetLedger>;
  /** YYYY-MM → all transactions dated in that month, every account merged. */
  transactionsByMonth: Record<string, TransactionRecord[]>;
};

/**
 * Derive every month in the union of ledger months and transaction months,
 * in ascending order, carrying balances forward:
 *
 *   activity(C, m)  = Σ amountCents where categoryId === C (transfers
 *                     excluded, pending included)
 *   income(m)       = Σ −amountCents where categoryId === "income"
 *   available(C, m) = carry(C, m−1) + assigned(C, m) − activity(C, m)
 *   carry(C, m)     = max(available(C, m), 0)   — overspend never haunts C
 *   overspend(m)    = Σ_C min(available(C, m), 0)
 *   tbb(M)          = Σ_{m≤M} income − Σ_{m≤M} assigned + Σ_{m<M} overspend
 *
 * Gap months (no ledger, no transactions) are skipped: with zero assignment
 * and zero activity they would change nothing, so carry passes through.
 */
export function deriveBudgetMonths(
  input: BudgetDerivationInput
): Record<string, BudgetMonthStateCore> {
  const months = [
    ...new Set([
      ...Object.keys(input.ledgers),
      ...Object.keys(input.transactionsByMonth),
      ...(input.flexPolicies ?? []).map((p) => p.month)
    ])
  ].sort();

  const result: Record<string, BudgetMonthStateCore> = {};
  // Only POSITIVE balances live here — a category whose available hits zero
  // (or below) drops out, so long-dead categories don't emit zero rows in
  // every later month.
  const carry: Record<string, bigint> = {};
  let cumIncome = 0n;
  let cumAssigned = 0n;
  let cumOverspend = 0n; // ≤ 0; applies to months AFTER the one that overspent

  for (const month of months) {
    const flex = flexForMonth(input.flexPolicies ?? [], month);
    if (flex?.active) {
      for (const id of flex.flexIds) {
        carry[FLEX_POOL] = (carry[FLEX_POOL] ?? 0n) + (carry[id] ?? 0n);
        delete carry[id];
      }
    }
    const assignments = routeFlexAmounts(input.ledgers[month]?.assignments ?? {}, flex);
    const activity: Record<string, bigint> = {};
    let income = 0n;
    const sourceRows = input.transactionsByMonth[month] ?? [];
    for (const txn of sourceRows) safeCents(txn.amountCents);
    for (const txn of sourceRows.flatMap(allocations)) {
      if (txn.categoryId === null || txn.categoryId === "transfers") continue;
      const categoryId =
        flex?.active && flex.flexIds.includes(txn.categoryId) ? FLEX_POOL : txn.categoryId;
      activity[categoryId] = (activity[categoryId] ?? 0n) + BigInt(safeCents(txn.amountCents));
      if (txn.categoryId === "income") income -= BigInt(safeCents(txn.amountCents));
    }

    const categoryIds = new Set([
      ...Object.keys(carry),
      ...Object.keys(assignments),
      ...Object.keys(activity)
    ]);
    const categories: Record<string, BudgetCategoryState> = {};
    let assignedTotal = 0n;
    let overspend = 0n;
    for (const categoryId of categoryIds) {
      const assignedCents = BigInt(safeCents(assignments[categoryId] ?? 0));
      const activityCents = activity[categoryId] ?? 0n;
      const availableCents = (carry[categoryId] ?? 0n) + assignedCents - activityCents;
      categories[categoryId] = {
        assignedCents: safeCents(assignedCents),
        activityCents: safeCents(activityCents),
        availableCents: safeCents(availableCents)
      };
      assignedTotal += assignedCents;
      if (availableCents > 0n) {
        carry[categoryId] = availableCents;
      } else {
        delete carry[categoryId];
        overspend += availableCents;
      }
    }

    cumIncome += income;
    cumAssigned += assignedTotal;
    result[month] = { tbbCents: safeCents(cumIncome - cumAssigned + cumOverspend), categories };
    cumOverspend += overspend;
  }

  return result;
}
