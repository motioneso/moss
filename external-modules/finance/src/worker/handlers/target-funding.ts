import type { ToolFactory } from "../registry.js";
import { InputError, readInt, readString } from "../validate.js";
import { targetProgress } from "../../domain/targets.js";
import {
  hasTargetFundingOverspending,
  targetFundingLines,
  selectTargetFunding,
  TargetFundingError
} from "../../domain/target-funding.js";
import { isCalendarMonth } from "../../domain/values.js";
import {
  budgetContext,
  readBudgetReview,
  requireSameReview,
  requireBudgetPolicy,
  staleBudget
} from "./budget-context.js";
import { today } from "./manual-ledger.js";
import { loadCategories } from "./feed.js";
export const targetFundHandler: ToolFactory = (ports) => async (input) => {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("invalid_month", "Choose a valid budget month");
  const date = today(ports);
  if (month !== date.slice(0, 7))
    throw new InputError(
      "current_month_required",
      "Fund targets from the current month's saved budget"
    );
  const ids = input.categoryIds,
    amounts = input.expectedAmountsCents;
  if (
    !Array.isArray(ids) ||
    !Array.isArray(amounts) ||
    ids.length < 1 ||
    ids.length > 20 ||
    ids.length !== amounts.length ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    throw new InputError(
      "invalid_selection",
      "Choose one to twenty different targets and their captured amounts"
    );
  const cents = amounts.map((value) =>
    readInt({ value }, "value", { required: true, min: 1, max: 100000000 })
  );
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.targets)
    throw new InputError("storage_upgrade_required", "Update Finance before funding targets");
  const context = await budgetContext(ports, store, month);
  if (context.setupRequired) throw staleBudget();
  requireSameReview(expected, context);
  if (
    hasTargetFundingOverspending(context.state.categories) ||
    context.cardPayments.some((c) => c.availableCents < 0)
  )
    throw new InputError(
      "cover_overspending",
      "Cover category and card-payment overspending before funding targets"
    );
  const progress = (await store.targets.forMonth(month)).map((target) =>
    targetProgress(target, context.state.categories[target.categoryId], month, date)
  );
  const lines = targetFundingLines(
    progress,
    context.state.categories,
    await loadCategories(ports),
    context.flex?.active ? context.flex.flexIds : []
  );
  let selected;
  try {
    selected = selectTargetFunding(lines, ids as string[], cents, context.readyToAssignCents);
  } catch (error) {
    if (error instanceof TargetFundingError) throw new InputError(error.code, error.message);
    throw error;
  }
  if (
    !(await store.commitBudgetChange({
      expected,
      month,
      assignments: selected.assignments,
      activity: selected.assignments.map((a) => ({
        actor: "user" as const,
        kind: "budget.assign",
        params: { month, ...a },
        undo: { month, categoryId: a.categoryId, amountCents: a.previousCents }
      }))
    }))
  )
    throw staleBudget();
  return { status: "ok", applied: selected.assignments.length, ...selected };
};
