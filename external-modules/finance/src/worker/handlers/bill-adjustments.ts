import type { ToolFactory } from "../registry.js";
import { InputError, readInt, readString } from "../validate.js";
import { isCalendarDate } from "../../domain/values.js";
import {
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
const identity = (input: Record<string, unknown>) => {
  const planId = readString(input, "planId", { required: true });
  const dueDate = readString(input, "dueDate", { required: true });
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(planId) ||
    !isCalendarDate(dueDate)
  )
    throw new InputError("invalid_occurrence", "Choose a saved scheduled bill occurrence");
  return { planId, dueDate };
};
export const billAdjustHandler: ToolFactory = (ports) => async (input) => {
  const { planId, dueDate } = identity(input);
  const plannedDate = readString(input, "plannedDate", { required: true });
  if (!isCalendarDate(plannedDate))
    throw new InputError("invalid_date", "Choose a valid planned date");
  const amountCents = readInt(input, "amountCents", { required: true, min: 1, max: 100000000 });
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.billAdjustments)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before changing one bill occurrence"
    );
  if (
    !(await store.billAdjustments.save(
      { planId, dueDate, plannedDate, amountCents },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", planId, dueDate };
};
export const billAdjustResetHandler: ToolFactory = (ports) => async (input) => {
  const { planId, dueDate } = identity(input);
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.billAdjustments)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before resetting one bill occurrence"
    );
  if (!(await store.billAdjustments.reset(planId, dueDate, expected, ports.now().toISOString())))
    throw staleBudget();
  return { status: "ok", planId, dueDate };
};
