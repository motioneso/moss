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
  const kind = readEnum(input, "kind", ["monthly", "balance", "removed"] as const, {
    required: true
  });
  const amountCents = readInt(input, "amountCents", {
    required: true,
    min: kind === "removed" ? 0 : 1,
    max: Number.MAX_SAFE_INTEGER
  });
  const date = readString(input, "dueDate");
  if (kind === "balance" && (!date || !isCalendarDate(date)))
    throw new InputError("Choose a valid target date");
  if (kind !== "balance" && date) throw new InputError("Only balance targets have a date");
  if (kind === "removed" && amountCents !== 0)
    throw new InputError("A removed target must have a zero amount");
  const expected = readBudgetReview(input);
  const store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.targets)
    throw new InputError("storage_upgrade_required", "Update Finance before saving targets");
  if (
    !(await store.targets.save(
      {
        categoryId,
        effectiveMonth: month,
        kind,
        amountCents,
        dueDate: kind === "balance" ? date! : null
      },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", categoryId, month };
};
