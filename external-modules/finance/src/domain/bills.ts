import type { BillSchedule } from "./recurrence.js";
import type { BudgetReview } from "./budget-context.js";
export interface BillPlan extends BillSchedule {
  id: string;
  name: string;
  accountId: string;
  categoryId: string;
  isoCurrency: string;
  amountCents: number;
}
export interface BillDecision {
  planId: string;
  dueDate: string;
  state: "skipped" | "matched";
  transactionId: string | null;
  actualCents?: number | null;
  matchedValid?: boolean;
}
export interface BillStore {
  plans(): Promise<BillPlan[]>;
  decisions(from: string, to: string): Promise<BillDecision[]>;
  create(plan: BillPlan, expected: BudgetReview, at: string): Promise<boolean>;
  stop(id: string, endDate: string, expected: BudgetReview, at: string): Promise<boolean>;
  clear(planId: string, dueDate: string, expected: BudgetReview, at: string): Promise<boolean>;
  decide(decision: BillDecision, expected: BudgetReview, at: string): Promise<boolean>;
}
