import { MAX_WEEKLY_CENTS } from "../../domain/weekly-targets.js";
import { assertCategoryFunding } from "./flex-guards.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import { isCalendarMonth, isCalendarDate } from "../../domain/values.js";
import {
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";

export const targetSetHandler: ToolFactory = (ports) => async (input) => {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("month must be YYYY-MM");
  const categoryId = readString(input, "categoryId", { required: true });
  const kind = readEnum(input, "kind", ["monthly", "weekly", "refill", "balance"] as const, {
    required: true
  });
  const amountCents = readInt(input, "amountCents", {
    required: true,
    min: 1,
    max: kind === "weekly" ? MAX_WEEKLY_CENTS : Number.MAX_SAFE_INTEGER
  });
  const weekday =
    kind === "weekly" ? readInt(input, "weekday", { required: true, min: 0, max: 6 }) : undefined;
  if (kind !== "weekly" && input.weekday !== undefined)
    throw new InputError("Only weekly targets have a weekday");
  const date = readString(input, "dueDate");
  if (kind === "balance" && (!date || !isCalendarDate(date)))
    throw new InputError("Choose a valid target date");
  if (kind !== "balance" && date) throw new InputError("Only balance targets have a date");
  const expected = readBudgetReview(input);
  const store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  await assertCategoryFunding(store, month, [categoryId]);
  if (!store.targets)
    throw new InputError("storage_upgrade_required", "Update Finance before saving targets");
  if (
    !(await store.targets.save(
      {
        categoryId,
        effectiveMonth: month,
        kind,
        amountCents,
        dueDate: kind === "balance" ? date! : null,
        ...(weekday !== undefined ? { weekday } : {})
      },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", categoryId, month };
};

// Removal skips the funding check, so an archived or pooled category can still drop its old target.
export const targetRemoveHandler: ToolFactory = (ports) => async (input) => {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("month must be YYYY-MM");
  const categoryId = readString(input, "categoryId", { required: true });
  const expected = readBudgetReview(input);
  const store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.targets)
    throw new InputError("storage_upgrade_required", "Update Finance before removing targets");
  if (
    !(await store.targets.save(
      { categoryId, effectiveMonth: month, kind: "removed", amountCents: 0, dueDate: null },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", categoryId, month };
};
