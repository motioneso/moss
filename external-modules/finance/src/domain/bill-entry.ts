import type { BudgetReview } from "./budget-context.js";
import type { ManualEntryCreate } from "./manual-ledger.js";
export interface BillEntryCreate extends ManualEntryCreate {
  planId: string;
  dueDate: string;
  today: string;
  review: BudgetReview;
}
export type BillEntryReplay = "unchanged" | "conflict" | null;
export interface BillEntryStore {
  entryReplay(
    id: string,
    digest: string,
    planId: string,
    dueDate: string
  ): Promise<BillEntryReplay>;
  recordEntry(entry: BillEntryCreate): Promise<boolean>;
}
