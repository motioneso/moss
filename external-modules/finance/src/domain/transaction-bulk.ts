import type { TransactionRecord } from "./records.js";
export interface ReviewedTransaction {
  id: string;
  writeRevision: string;
}
export interface TransactionBulkStore {
  monthRows(month: string): Promise<(TransactionRecord & { writeRevision: string })[]>;
  categorize(rows: readonly ReviewedTransaction[], categoryId: string): Promise<boolean>;
  confirm?(rows: readonly ReviewedTransaction[]): Promise<boolean>;
}
