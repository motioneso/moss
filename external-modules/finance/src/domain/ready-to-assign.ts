// external-modules/finance/src/domain/ready-to-assign.ts
//
// #3173: "ready to assign" reconciles the budget with the bank accounts.
//
//   ready = Σ signed account balances − Σ available over budgeted categories
//
// Only cash accounts and credit cards count; cards count negative, so card
// debt is already netted. Loans and investments are left out. Card spending
// lowers a category's available and the card balance by the same amount, so
// ready does not move. Income and transfers are not envelopes and are excluded.

import { signedBalanceCents, type BalanceLike } from "./account-sign.js";
import { safeCents } from "./values.js";
import type { BudgetCategoryState } from "./envelope.js";

export type { BalanceLike };
export { signedBalanceCents };

/** Cash accounts and credit cards fund the budget; loans and investments do not. */
export function countsTowardReady(type: string, subtype?: string | null): boolean {
  return type === "depository" || type === "credit" || (type === "other" && subtype === "cash");
}

const NON_ENVELOPE_IDS: ReadonlySet<string> = new Set(["income", "transfers"]);

export function readyToAssignCents(
  accounts: readonly BalanceLike[],
  categories: Record<string, BudgetCategoryState>
): number {
  let ready = accounts
    .filter((account) => countsTowardReady(account.type, account.subtype))
    .reduce((sum, account) => sum + BigInt(safeCents(signedBalanceCents(account))), 0n);
  for (const [categoryId, state] of Object.entries(categories)) {
    if (NON_ENVELOPE_IDS.has(categoryId)) continue;
    ready -= BigInt(safeCents(state.availableCents));
  }
  return safeCents(ready);
}
