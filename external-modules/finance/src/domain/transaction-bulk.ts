import type { TransactionRecord } from "./records.js";
export interface ReviewedTransaction {
  id: string;
  writeRevision: string;
}
/** What one confirm changed, enough to put the row back. */
export interface ConfirmedTransaction extends ReviewedTransaction {
  categorizedBy: "rule" | "plaid-map" | "ai" | "user" | null;
}
export interface TransactionBulkStore {
  monthRows(month: string): Promise<(TransactionRecord & { writeRevision: string })[]>;
  categorize(rows: readonly ReviewedTransaction[], categoryId: string): Promise<boolean>;
  confirm?(rows: readonly ReviewedTransaction[]): Promise<boolean>;
  /** Confirms like `confirm`; returns each row's new revision and prior source, or null when nothing applied. */
  confirmWithUndo?(rows: readonly ReviewedTransaction[]): Promise<ConfirmedTransaction[] | null>;
  /** Puts confirmed rows back to needs-look with their prior source; false when any row changed since. */
  unconfirm?(rows: readonly ConfirmedTransaction[]): Promise<boolean>;
}
