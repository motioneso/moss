// external-modules/finance/src/worker/handlers/budget.ts
//
// FIN-03 (#1148) Task 3: the envelope-budget handlers over the pure
// derivation in domain/envelope.ts (spec delta §"Worker delta"). Cut over to
// FinanceStore and the `state:{YYYY-MM}` cache retired by FIN-06c (#1166)
// Task 10 (F6-D1): that cache was a KV-read-amplification workaround — a SQL
// month read is one indexed query, so status now always derives fresh from
// loadDerivationInput and never persists.
//
// Storage contract: `ledger:{YYYY-MM}` (assignment SOURCE OF TRUTH; assign
// SETS a total per category, never increments, keeping the budget-apply
// queue replay-safe at retryLimit 1) lives behind `store.listAssignmentMonths`
// / `store.getLedger` / `store.setAssignment`.
//
// Two write paths, one apply: the assistant tool (budget.assign) and the
// web queue twin (finance.budget-apply) both converge on applyAssignment.
// The queue handler receives the HOST job envelope {actorUserId, jobKind,
// idempotencyKey, params} — command fields ride in params, never flat
// (the a6023cb7 regression from FIN-02).

import { isCalendarMonth, tableGroupFor } from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";
import { budgetContext, requireBudgetPolicy } from "./budget-context.js";

// Mirrors the manifest bound on finance.budget-apply's amountCents param —
// ±$1M in cents. The manifest gate runs host-side; this re-check covers the
// tool path, which never crosses the queue params schema.
const AMOUNT_BOUND = 100_000_000;

/** Most categories one budget-apply job may carry (keeps params under the host size cap). */
export const MAX_BATCH = 20;

function readMonth(input: Record<string, unknown>): string {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) {
    throw new InputError("month must be YYYY-MM");
  }
  return month;
}

export const budgetStatusHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const context = await budgetContext(ports, await ports.store(), month);
  const categories = (await loadCategories(ports)).map((category) => ({
    ...category,
    tableGroup: tableGroupFor(category.group)
  }));
  return { month, ...context, categories };
};

/**
 * Shared write path: validate, SET the assigned category's total, and log it.
 * The activity row carries ids and cents only; undo restores the old total.
 */
async function applyAssignment(
  ports: WorkerPorts,
  args: { month: string; categoryId: string; amountCents: number },
  actor: "user" | "moss",
  liveIds?: ReadonlySet<string>
): Promise<Record<string, unknown>> {
  const live =
    liveIds ??
    new Set(
      (await loadCategories(ports)).filter((entry) => !entry.archived).map((entry) => entry.id)
    );
  if (!live.has(args.categoryId)) {
    throw new InputError("invalid_category", "categoryId is not a live category");
  }

  const store = await ports.store();
  await requireBudgetPolicy(store);
  const previousCents = (await store.getLedger(args.month))?.assignments[args.categoryId] ?? 0;
  await store.setAssignment(args.month, args.categoryId, args.amountCents);

  // The total and its activity row are two writes. When a run dies between them, the retry
  // finds the total already set, so it also checks the newest row logged for this category.
  const logged = await store.lastLoggedAssignment(args.month, args.categoryId);
  const changed = previousCents !== args.amountCents;
  const missingRow = !changed && logged !== null && logged !== args.amountCents;
  if (changed || missingRow) {
    const baseline = changed ? previousCents : (logged as number);
    await store.appendActivity({
      actor,
      kind: "budget.assign",
      params: {
        month: args.month,
        categoryId: args.categoryId,
        amountCents: args.amountCents,
        previousCents: baseline
      },
      undo: { month: args.month, categoryId: args.categoryId, amountCents: baseline }
    });
  }

  return { status: "ok", ...args };
}

export const budgetAssignHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const categoryId = readString(input, "categoryId", { required: true });
  const amountCents = readInt(input, "amountCents", {
    required: true,
    min: -AMOUNT_BOUND,
    max: AMOUNT_BOUND
  });
  // The gateway's dollar limit measures the jump from previousCents, so a stale or
  // invented base would hide a large change. Reject anything that differs from the stored total.
  const previousCents = readInt(input, "previousCents", {
    required: true,
    min: -AMOUNT_BOUND,
    max: AMOUNT_BOUND
  });
  const store = await ports.store();
  await requireBudgetPolicy(store);
  const stored = (await store.getLedger(month))?.assignments[categoryId] ?? 0;
  if (stored !== previousCents) {
    throw new InputError(
      "stale_previous",
      "previousCents does not match the stored total; read finance.budget.status again"
    );
  }
  const result = await applyAssignment(ports, { month, categoryId, amountCents }, "moss");
  return {
    ...result,
    before: { assignedCents: previousCents },
    after: { assignedCents: amountCents }
  };
};

/** Source id that draws from unassigned money instead of a category. */
export const READY_TO_ASSIGN = "ready_to_assign";

/**
 * Moves money between two categories for one month, or from unassigned money into one.
 * The source must hold the amount (its available balance, or the ready-to-assign figure).
 */
export const budgetMoveHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const fromCategoryId = readString(input, "fromCategoryId", { required: true });
  const toCategoryId = readString(input, "toCategoryId", { required: true });
  const amountCents = readInt(input, "amountCents", { required: true, min: 1, max: AMOUNT_BOUND });
  if (toCategoryId === READY_TO_ASSIGN) {
    throw new InputError("invalid_category", "toCategoryId must be a category");
  }
  if (fromCategoryId === toCategoryId) {
    throw new InputError("invalid_category", "fromCategoryId and toCategoryId must differ");
  }
  const live = new Set(
    (await loadCategories(ports)).filter((entry) => !entry.archived).map((entry) => entry.id)
  );
  if (
    !live.has(toCategoryId) ||
    (fromCategoryId !== READY_TO_ASSIGN && !live.has(fromCategoryId))
  ) {
    throw new InputError("invalid_category", "a category id is not a live category");
  }

  const store = await ports.store();
  await requireBudgetPolicy(store);
  const context = await budgetContext(ports, store, month);
  if (context.setupRequired)
    throw new InputError("budget_currency_required", "Choose your budget currency first");
  const { state } = context;
  const assigned = (await store.getLedger(month))?.assignments ?? {};
  const toBefore = assigned[toCategoryId] ?? 0;
  let fromBefore: number | null = null;
  if (fromCategoryId === READY_TO_ASSIGN) {
    const ready = context.readyToAssignCents;
    if (ready === null)
      throw new InputError("funding_unavailable", "Ready to assign is unavailable for this month");
    if (amountCents > ready) {
      throw new InputError("not_enough_ready", "amountCents is more than is ready to assign");
    }
  } else {
    fromBefore = assigned[fromCategoryId] ?? 0;
    const available = state.categories[fromCategoryId]?.availableCents ?? fromBefore;
    if (amountCents > available) {
      throw new InputError("not_enough_available", "amountCents is more than the source holds");
    }
  }

  // Both totals and the activity row land in one atomic write, so a failure changes nothing.
  await store.commitBudgetChange({
    month,
    assignments: [
      ...(fromBefore === null
        ? []
        : [{ categoryId: fromCategoryId, amountCents: fromBefore - amountCents }]),
      { categoryId: toCategoryId, amountCents: toBefore + amountCents }
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
  });

  return {
    status: "ok",
    month,
    fromCategoryId,
    toCategoryId,
    amountCents,
    before: { fromAssignedCents: fromBefore, toAssignedCents: toBefore },
    after: {
      fromAssignedCents: fromBefore === null ? null : fromBefore - amountCents,
      toAssignedCents: toBefore + amountCents
    }
  };
};

/** Queue twin of budget.assign — consumes the host job envelope. */
export const budgetApplyHandler: ToolFactory = (ports) => async (input) => {
  const jobKind = readString(input, "jobKind", { required: true });
  if (jobKind !== "finance.budget-apply") {
    throw new InputError("jobKind is not supported by this handler");
  }
  const params = input.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  const command = params as Record<string, unknown>;
  const month = readMonth(command);
  const liveIds = new Set(
    (await loadCategories(ports)).filter((entry) => !entry.archived).map((entry) => entry.id)
  );

  // Batch shape: parallel arrays. The single-category shape stays readable for jobs
  // queued before the batch shape existed.
  if (Array.isArray(command.categoryIds)) {
    const ids = command.categoryIds as unknown[];
    const amounts = Array.isArray(command.amountsCents) ? (command.amountsCents as unknown[]) : [];
    if (ids.length === 0 || ids.length !== amounts.length || ids.length > MAX_BATCH) {
      throw new InputError("categoryIds and amountsCents must be equal-length, 1 to 20 items");
    }
    const assignments: { categoryId: string; amountCents: number }[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const amountCents = amounts[i];
      if (
        typeof ids[i] !== "string" ||
        typeof amountCents !== "number" ||
        !Number.isInteger(amountCents) ||
        Math.abs(amountCents) > AMOUNT_BOUND
      ) {
        throw new InputError("each batch item needs a category id and an integer amount");
      }
      const categoryId = ids[i] as string;
      if (!liveIds.has(categoryId))
        throw new InputError("invalid_category", "categoryId is not a live category");
      if (assignments.some((a) => a.categoryId === categoryId))
        throw new InputError("categoryIds must be unique");
      assignments.push({ categoryId, amountCents });
    }
    const store = await ports.store();
    await requireBudgetPolicy(store);
    const before = (await store.getLedger(month))?.assignments ?? {};
    await store.commitBudgetChange({
      month,
      assignments,
      activity: assignments
        .filter((a) => (before[a.categoryId] ?? 0) !== a.amountCents)
        .map((a) => ({
          actor: "user",
          kind: "budget.assign",
          params: { month, ...a, previousCents: before[a.categoryId] ?? 0 },
          undo: { month, categoryId: a.categoryId, amountCents: before[a.categoryId] ?? 0 }
        }))
    });
    return { status: "ok", applied: assignments.length };
  }

  const categoryId = readString(command, "categoryId", { required: true });
  const amountCents = readInt(command, "amountCents", {
    required: true,
    min: -AMOUNT_BOUND,
    max: AMOUNT_BOUND
  });
  return applyAssignment(ports, { month, categoryId, amountCents }, "user", liveIds);
};
