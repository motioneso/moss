import type { BillPlan } from "./bills.js";
import type { BudgetReview } from "./budget-context.js";
import { billOccurrences } from "./recurrence.js";
import { isCalendarDate, safeCents } from "./values.js";
export interface BillAdjustment {
  planId: string;
  /** Immutable occurrence identity: the original schedule date, not its displayed date. */
  dueDate: string;
  plannedDate: string;
  amountCents: number;
}
export interface BillAdjustmentStore {
  rows(from: string, to: string): Promise<BillAdjustment[]>;
  save(change: BillAdjustment, review: BudgetReview, at: string): Promise<boolean>;
  reset(planId: string, dueDate: string, review: BudgetReview, at: string): Promise<boolean>;
  claimedTransactionIds(ids: readonly string[]): Promise<string[]>;
}
export interface BillProjection {
  planId: string;
  name: string;
  accountId: string;
  categoryId: string;
  dueDate: string;
  plannedDate: string;
  expectedCents: number;
  adjusted: boolean;
}
/** Read-window bounds remain independent of how far an individual occurrence was moved. */
export function projectBillOccurrences(
  plans: readonly BillPlan[],
  adjustments: readonly BillAdjustment[],
  from: string,
  to: string
): BillProjection[] {
  billOccurrences({ anchorDate: from, cadence: "once" }, from, to);
  const byPlan = new Map<string, Map<string, BillAdjustment>>();
  for (const change of adjustments) {
    const plan = plans.find((p) => p.id === change.planId);
    if (
      !plan ||
      !isCalendarDate(change.dueDate) ||
      !isCalendarDate(change.plannedDate) ||
      safeCents(change.amountCents) <= 0 ||
      !billOccurrences(plan, change.dueDate, change.dueDate).includes(change.dueDate)
    )
      throw new Error("A saved bill adjustment needs review");
    const held = byPlan.get(plan.id) ?? new Map<string, BillAdjustment>();
    if (held.has(change.dueDate)) throw new Error("A bill occurrence has duplicate adjustments");
    held.set(change.dueDate, change);
    byPlan.set(plan.id, held);
  }
  const result: BillProjection[] = [];
  for (const plan of plans) {
    const changes = byPlan.get(plan.id);
    const dates = new Set([...billOccurrences(plan, from, to), ...(changes?.keys() ?? [])]);
    for (const dueDate of dates) {
      const change = changes?.get(dueDate),
        plannedDate = change?.plannedDate ?? dueDate;
      if (plannedDate < from || plannedDate > to) continue;
      const expectedCents = safeCents(change?.amountCents ?? plan.amountCents);
      if (expectedCents <= 0) throw new Error("Bill projections require a positive expense amount");
      result.push({
        planId: plan.id,
        name: plan.name,
        accountId: plan.accountId,
        categoryId: plan.categoryId,
        dueDate,
        plannedDate,
        expectedCents,
        adjusted: Boolean(change)
      });
      if (result.length > 500)
        throw new Error("Use a shorter window to show no more than 500 occurrences");
    }
  }
  return result.sort(
    (a, b) =>
      a.plannedDate.localeCompare(b.plannedDate) ||
      a.name.localeCompare(b.name) ||
      a.dueDate.localeCompare(b.dueDate)
  );
}
