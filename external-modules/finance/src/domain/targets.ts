import { safeCents } from "./values.js";
import type { BudgetCategoryState } from "./envelope.js";
import type { BudgetReview } from "./budget-context.js";

export interface CategoryTarget {
  categoryId: string;
  effectiveMonth: string;
  kind: "monthly" | "balance" | "removed";
  amountCents: number;
  dueDate: string | null;
}
export interface TargetProgress extends CategoryTarget {
  progressCents: number;
  remainingCents: number;
  suggestedCents: number;
  status: "reached" | "overdue" | "in-progress";
}
export interface TargetStore {
  forMonth(month: string): Promise<CategoryTarget[]>;
  versions?(): Promise<CategoryTarget[]>;
  save(target: CategoryTarget, expected: BudgetReview, at: string): Promise<boolean>;
}
const monthIndex = (month: string): number =>
  Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
/** A target guides the existing envelope. It never creates a second fund allocation. */
export function targetProgress(
  target: CategoryTarget,
  state: BudgetCategoryState | undefined,
  month: string,
  asOfDate: string
): TargetProgress {
  const amount = BigInt(safeCents(target.amountCents));
  const base = BigInt(
    safeCents(
      target.kind === "monthly" ? (state?.assignedCents ?? 0) : (state?.availableCents ?? 0)
    )
  );
  const remaining = amount > base ? amount - base : 0n;
  const progress = base < 0n ? 0n : base;
  const overdue = target.kind === "balance" && target.dueDate !== null && target.dueDate < asOfDate;
  const months =
    target.kind === "balance" && target.dueDate
      ? Math.max(1, monthIndex(target.dueDate) - monthIndex(month) + 1)
      : 1;
  return {
    ...target,
    progressCents: safeCents(progress),
    remainingCents: safeCents(remaining),
    suggestedCents: safeCents((remaining + BigInt(months) - 1n) / BigInt(months)),
    status: remaining === 0n ? "reached" : overdue ? "overdue" : "in-progress"
  };
}
