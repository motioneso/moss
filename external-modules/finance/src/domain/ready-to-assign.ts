// external-modules/finance/src/domain/ready-to-assign.ts
//
// #3173: "ready to assign" reconciles the budget with the bank accounts.
//
//   ready = Σ signed account balances − Σ available over budgeted categories
//
// Cards and loans count negative, so card debt is already netted. Card spending
// lowers a category's available and the card balance by the same amount, so
// ready does not move. Income and transfers are not envelopes and are excluded.

import type { BudgetCategoryState } from "./envelope.js";

export type BalanceLike = { type: string; balanceCents: number };

/** Plaid reports credit and loan balances as amounts owed (positive). */
export function signedBalanceCents(account: BalanceLike): number {
  return account.type === "credit" || account.type === "loan"
    ? -account.balanceCents
    : account.balanceCents;
}

const NON_ENVELOPE_IDS: ReadonlySet<string> = new Set(["income", "transfers"]);

export function readyToAssignCents(
  accounts: readonly BalanceLike[],
  categories: Record<string, BudgetCategoryState>
): number {
  let ready = accounts.reduce((sum, account) => sum + signedBalanceCents(account), 0);
  for (const [categoryId, state] of Object.entries(categories)) {
    if (NON_ENVELOPE_IDS.has(categoryId)) continue;
    ready -= state.availableCents;
  }
  return ready;
}
