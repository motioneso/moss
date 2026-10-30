import { weeklyTargetPeriod, type WeeklyTargetPeriod } from "./weekly-targets.js";
import { safeCents } from "./values.js";
import type { BudgetCategoryState } from "./envelope.js";
import type { BudgetReview } from "./budget-context.js";

export interface CategoryTarget {
  categoryId: string;
  effectiveMonth: string;
  kind: "monthly" | "weekly" | "refill" | "balance" | "removed";
  amountCents: number;
  dueDate: string | null;
  weekday?: number;
}
export interface TargetProgress extends CategoryTarget {
  weekly?: WeeklyTargetPeriod;
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
  const weekly =
    target.kind === "weekly"
      ? weeklyTargetPeriod(month, target.weekday!, target.amountCents)
      : undefined;
  const amount = BigInt(weekly?.totalCents ?? safeCents(target.amountCents));
  const base =
    target.kind === "refill"
      ? BigInt(safeCents(state?.availableCents ?? 0)) + BigInt(safeCents(state?.activityCents ?? 0))
      : BigInt(
          safeCents(
            target.kind === "monthly" || target.kind === "weekly"
              ? (state?.assignedCents ?? 0)
              : (state?.availableCents ?? 0)
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
    ...(weekly ? { weekly } : {}),
    progressCents: safeCents(progress),
    remainingCents: safeCents(remaining),
    suggestedCents: safeCents((remaining + BigInt(months) - 1n) / BigInt(months)),
    status: remaining === 0n ? "reached" : overdue ? "overdue" : "in-progress"
  };
}
