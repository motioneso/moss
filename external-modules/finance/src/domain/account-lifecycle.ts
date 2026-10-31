export type AccountOperation = "rename" | "close" | "reopen";
export type AccountCloseBlocker =
  | "not_open"
  | "nonzero_balance"
  | "invalid_ledger"
  | "future_entries"
  | "unreconciled"
  | "future_plans";
export interface AccountReview {
  accountId: string;
  name: string;
  type: string;
  subtype: string | null;
  isoCurrency: string;
  balanceCents: number;
  openingBalanceCents: number;
  openingDate: string;
  balanceAsOf: string;
  archivedAt: string | null;
  lastReconciledDate: string | null;
  lastEntryDate: string | null;
  revision: string;
  canClose: boolean;
  blockers: AccountCloseBlocker[];
  futurePlanCount: number;
}
export interface AccountUpdate {
  accountId: string;
  expectedRevision: string;
  operation: AccountOperation;
  name?: string;
  today: string;
  at: string;
}
export interface AccountLifecycleStore {
  review(accountId: string, today: string): Promise<AccountReview | null>;
  update(input: AccountUpdate): Promise<boolean>;
}
