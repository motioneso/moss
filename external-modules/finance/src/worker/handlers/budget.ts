import { today } from "./manual-ledger.js";
import { targetProgress } from "../../domain/targets.js";
import {
  isCalendarMonth,
  safeCents,
  tableGroupFor,
  type BudgetReview
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";
import {
  budgetContext,
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";

const AMOUNT_BOUND = 100_000_000;
export const MAX_BATCH = 20;
export const READY_TO_ASSIGN = "ready_to_assign";
function readMonth(input: Record<string, unknown>): string {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("month must be YYYY-MM");
  return month;
}
const amount = (input: Record<string, unknown>, key: string) =>
  readInt(input, key, { required: true, min: -AMOUNT_BOUND, max: AMOUNT_BOUND });
async function liveCategories(ports: WorkerPorts) {
  return new Set(
    (await loadCategories(ports))
      .filter((c) => !c.archived && c.id !== "income" && c.id !== "transfers")
      .map((c) => c.id)
  );
}
export const budgetStatusHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const store = await ports.store();
  const context = await budgetContext(ports, store, month);
  const categories = (await loadCategories(ports)).map((category) => ({
    ...category,
    tableGroup: tableGroupFor(category.group)
  }));
  const targets = context.setupRequired
    ? []
    : ((await store.targets?.forMonth(month)) ?? []).map((target) =>
        targetProgress(
          target,
          context.state.categories[target.categoryId],
          month,
          month < today(ports).slice(0, 7)
            ? `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()}`
            : month > today(ports).slice(0, 7)
              ? `${month}-01`
              : today(ports)
        )
      );
  if (!context.setupRequired) requireSameReview(context, await requireBudgetPolicy(store));
  return { month, ...context, categories, targets };
};

async function applyAssignments(
  ports: WorkerPorts,
  month: string,
  assignments: { categoryId: string; amountCents: number; previousCents: number }[],
  expected: BudgetReview,
  actor: "user" | "moss"
) {
  const store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  const live = await liveCategories(ports);
  const ledger = (await store.getLedger(month))?.assignments ?? {};
  for (const a of assignments) {
    if (!live.has(a.categoryId))
      throw new InputError("invalid_category", "categoryId is not a live category");
    if ((ledger[a.categoryId] ?? 0) !== a.previousCents)
      throw new InputError(
        "stale_previous",
        "previousCents does not match the stored total; read finance.budget.status again"
      );
  }
  const applied = await store.commitBudgetChange({
    expected,
    month,
    assignments,
    activity: assignments
      .filter((a) => a.amountCents !== a.previousCents)
      .map((a) => ({
        actor,
        kind: "budget.assign",
        params: { month, ...a },
        undo: { month, categoryId: a.categoryId, amountCents: a.previousCents }
      }))
  });
  if (!applied) throw staleBudget();
  return { status: "ok", applied: assignments.length };
}
export const budgetAssignHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const categoryId = readString(input, "categoryId", { required: true });
  const amountCents = amount(input, "amountCents");
  const previousCents = amount(input, "previousCents");
  const result = await applyAssignments(
    ports,
    month,
    [{ categoryId, amountCents, previousCents }],
    readBudgetReview(input),
    "moss"
  );
  return {
    status: result.status,
    month,
    categoryId,
    amountCents,
    before: { assignedCents: previousCents },
    after: { assignedCents: amountCents }
  };
};

export const budgetMoveHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const fromCategoryId = readString(input, "fromCategoryId", { required: true });
  const toCategoryId = readString(input, "toCategoryId", { required: true });
  const amountCents = readInt(input, "amountCents", { required: true, min: 1, max: AMOUNT_BOUND });
  if (toCategoryId === READY_TO_ASSIGN)
    throw new InputError("invalid_category", "toCategoryId must be a category");
  if (fromCategoryId === toCategoryId)
    throw new InputError("invalid_category", "fromCategoryId and toCategoryId must differ");
  const expected = readBudgetReview(input);
  const store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  const live = await liveCategories(ports);
  if (!live.has(toCategoryId) || (fromCategoryId !== READY_TO_ASSIGN && !live.has(fromCategoryId)))
    throw new InputError("invalid_category", "a category id is not a live category");
  const context = await budgetContext(ports, store, month);
  if (context.setupRequired) throw staleBudget();
  requireSameReview(expected, context);
  const fromBefore =
    fromCategoryId === READY_TO_ASSIGN
      ? null
      : (context.state.categories[fromCategoryId]?.assignedCents ?? 0);
  const toBefore = context.state.categories[toCategoryId]?.assignedCents ?? 0;
  const available =
    fromBefore === null
      ? context.readyToAssignCents
      : (context.state.categories[fromCategoryId]?.availableCents ?? fromBefore);
  if (available === null)
    throw new InputError("funding_unavailable", "Ready to assign is unavailable for this month");
  if (amountCents > available)
    throw new InputError(
      fromBefore === null ? "not_enough_ready" : "not_enough_available",
      fromBefore === null
        ? "amountCents is more than is ready to assign"
        : "amountCents is more than the source holds"
    );
  const fromAfter =
    fromBefore === null ? null : safeCents(BigInt(fromBefore) - BigInt(amountCents));
  const toAfter = safeCents(BigInt(toBefore) + BigInt(amountCents));
  if (
    !(await store.commitBudgetChange({
      expected,
      month,
      assignments: [
        ...(fromAfter === null ? [] : [{ categoryId: fromCategoryId, amountCents: fromAfter }]),
        { categoryId: toCategoryId, amountCents: toAfter }
      ],
      activity: [
        {
          actor: "moss",
          kind: "budget.move",
          params: { month, fromCategoryId, toCategoryId, amountCents },
          undo: {
            month,
            fromCategoryId,
            toCategoryId,
            fromPreviousCents: fromBefore,
            toPreviousCents: toBefore
          }
        }
      ]
    }))
  )
    throw staleBudget();
  return {
    status: "ok",
    month,
    fromCategoryId,
    toCategoryId,
    amountCents,
    before: { fromAssignedCents: fromBefore, toAssignedCents: toBefore },
    after: { fromAssignedCents: fromAfter, toAssignedCents: toAfter }
  };
};

/** Older queued commands without review tokens fail closed; they never gain a fresh review. */
export const budgetApplyHandler: ToolFactory = (ports) => async (input) => {
  if (readString(input, "jobKind", { required: true }) !== "finance.budget-apply")
    throw new InputError("jobKind is not supported by this handler");
  if (typeof input.params !== "object" || input.params === null || Array.isArray(input.params))
    throw new InputError("params must be an object");
  const command = input.params as Record<string, unknown>;
  const month = readMonth(command);
  if (!Array.isArray(command.categoryIds)) {
    const categoryId = readString(command, "categoryId", { required: true });
    const amountCents = amount(command, "amountCents");
    const previousCents = amount(command, "previousCents");
    await applyAssignments(
      ports,
      month,
      [{ categoryId, amountCents, previousCents }],
      readBudgetReview(command),
      "user"
    );
    return { status: "ok", month, categoryId, amountCents };
  }
  const ids = command.categoryIds;
  const amounts = command.amountsCents;
  const previous = command.previousAmountsCents;
  if (
    !Array.isArray(amounts) ||
    !Array.isArray(previous) ||
    ids.length < 1 ||
    ids.length > MAX_BATCH ||
    ids.length !== amounts.length ||
    ids.length !== previous.length
  )
    throw new InputError(
      "categoryIds, amountsCents and previousAmountsCents must be equal-length, 1 to 20 items"
    );
  const assignments = ids.map((id, index) => {
    if (typeof id !== "string")
      throw new InputError("each batch item needs a category id and an integer amount");
    return {
      categoryId: id,
      amountCents: amount({ value: amounts[index] }, "value"),
      previousCents: amount({ value: previous[index] }, "value")
    };
  });
  if (new Set(ids).size !== ids.length) throw new InputError("categoryIds must be unique");
  return applyAssignments(ports, month, assignments, readBudgetReview(command), "user");
};
