// external-modules/finance/src/domain/account-sign.ts
//
// The one sign rule for account balances. Plaid reports credit and loan
// balances as amounts owed (positive); money views show them negative.
// Dependency-free so the web bundle can deep-import it.

export type BalanceLike = { type: string; balanceCents: number };

/** True for account types whose balance is an amount owed. */
export function isDebtType(type: string): boolean {
  return type === "credit" || type === "loan";
}

/** +1 for assets, -1 for debts. */
export function balanceSign(type: string): 1 | -1 {
  return isDebtType(type) ? -1 : 1;
}

export function signedBalanceCents(account: BalanceLike): number {
  return balanceSign(account.type) * account.balanceCents;
}
