// external-modules/finance/src/domain/store-port.ts
// FIN-06 (#1166, F6-D3): the storage port both impls satisfy. Vocabulary is
// deliberately the SAME record/chunk shapes handlers use today so the FIN-06c
// cutover is a call-site swap, not a data-model rewrite. Months are "YYYY-MM".
// Domain files never import @moss/* (bundler independence — see kv-port.ts).
import type { AccountRecord, ItemRecord, TransactionRecord } from "./records.js";
import type { BudgetLedger } from "./envelope.js";

/**
 * One row of the activity trail (#3174). `params` and `undo` hold ids, cents
 * and category ids only, never free text; the row's wording renders from
 * `kind` plus `params` in code.
 */
export interface ActivityInput {
  actor: "user" | "moss";
  kind: string;
  params: Record<string, string | number | null>;
  undo?: Record<string, string | number | null> | null;
}

export interface FinanceStore {
  listItems(): Promise<ItemRecord[]>;
  getItem(itemId: string): Promise<ItemRecord | null>;
  putItem(record: ItemRecord): Promise<void>;

  listAccounts(): Promise<AccountRecord[]>;
  getAccount(accountId: string): Promise<AccountRecord | null>;
  putAccount(record: AccountRecord): Promise<void>;

  /** Distinct months with transactions, newest first. */
  listTransactionMonths(): Promise<string[]>;
  /** All of one month across accounts, sorted date DESC then id ASC. */
  listMonthTransactions(month: string): Promise<TransactionRecord[]>;
  /** One account's month, same sort; null when empty (KV chunk parity). */
  getTransactionChunk(accountId: string, month: string): Promise<TransactionRecord[] | null>;
  /**
   * Replace one (account, month) window: upsert `records`, prune rows whose
   * id is absent (pending-twin removal / provider removals). Not atomic —
   * both halves are idempotent and re-sync converges (cursor persists last).
   */
  putTransactionChunk(
    accountId: string,
    month: string,
    records: TransactionRecord[]
  ): Promise<void>;
  /**
   * Payee names (transaction `name`) of categorized rows whose review state is
   * confirmed. A merchant counts as "seen" when its normalized name is here.
   */
  listConfirmedPayeeNames(): Promise<string[]>;
  /** Rewrite a single transaction in place (feed categorize/note paths). */
  putTransaction(record: TransactionRecord): Promise<void>;

  /** Every (accountId, month) snapshot window that exists. */
  listSnapshotChunks(): Promise<{ accountId: string; month: string }[]>;
  /** day (YYYY-MM-DD) -> balanceCents; null when the window is empty. */
  getSnapshotChunk(accountId: string, month: string): Promise<Record<string, number> | null>;
  putSnapshotChunk(accountId: string, month: string, days: Record<string, number>): Promise<void>;

  /** Months that have any assignment row, ascending. */
  listAssignmentMonths(): Promise<string[]>;
  getLedger(month: string): Promise<BudgetLedger | null>;
  /** Sets the TOTAL for one category (FIN-03 replay-safe semantics). */
  setAssignment(month: string, categoryId: string, amountCents: number): Promise<void>;

  /** Appends one activity row for the acting user, stamped with the current time. */
  appendActivity(entry: ActivityInput): Promise<void>;
}
