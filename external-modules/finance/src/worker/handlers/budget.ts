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

import {
  deriveBudgetMonths,
  effectiveTransferIds,
  type BudgetLedger,
  type BudgetMonthState,
  type FinanceStore,
  readyToAssignCents,
  signedBalanceCents,
  tableGroupFor,
  type TransactionRecord
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

const MONTH = /^[0-9]{4}-[0-9]{2}$/;
// Mirrors the manifest bound on finance.budget-apply's amountCents param —
// ±$1M in cents. The manifest gate runs host-side; this re-check covers the
// tool path, which never crosses the queue params schema.
const AMOUNT_BOUND = 100_000_000;

/** Most categories one budget-apply job may carry (keeps params under the host size cap). */
export const MAX_BATCH = 20;

function readMonth(input: Record<string, unknown>): string {
  const month = readString(input, "month", { required: true });
  if (!MONTH.test(month)) {
    throw new InputError("month must be YYYY-MM");
  }
  return month;
}

/**
 * Load the full derivation input: every assignment ledger plus every
 * transaction chunk, grouped by the chunk key's month suffix
 * (`{accountId}:{YYYY-MM}` — the reducer files each txn under its date's
 * month, so the key month IS the txn month).
 */
async function loadDerivationInput(store: FinanceStore): Promise<{
  ledgers: Record<string, BudgetLedger>;
  transactionsByMonth: Record<string, TransactionRecord[]>;
  /** Rows by month, before transfer rows are dropped. */
  allRowsByMonth: Record<string, TransactionRecord[]>;
  assignmentMonthCount: number;
}> {
  const ledgers: Record<string, BudgetLedger> = {};
  const assignmentMonths = await store.listAssignmentMonths();
  for (const month of assignmentMonths) {
    const ledger = await store.getLedger(month);
    if (ledger) ledgers[month] = ledger;
  }

  const transactionsByMonth: Record<string, TransactionRecord[]> = {};
  for (const month of await store.listTransactionMonths()) {
    const records = await store.listMonthTransactions(month);
    if (records.length) transactionsByMonth[month] = records;
  }
  // FIN-05 (#1150): drop the effective transfer set (auto-paired rows ∪
  // transfers-categorized) BEFORE derivation. Pairing needs the full
  // cross-month set, so it runs over the flattened months here, not per
  // month. deriveBudgetMonths keeps its own transfers/null skip as defense
  // in depth — this filter only ever removes MORE rows (paired legs whose
  // category is not "transfers", e.g. a transfer-in miscategorized as
  // income inflating TBB).
  const allRowsByMonth = { ...transactionsByMonth };
  const excluded = effectiveTransferIds(Object.values(transactionsByMonth).flat());
  for (const month of Object.keys(transactionsByMonth)) {
    transactionsByMonth[month] = transactionsByMonth[month]!.filter((txn) => !excluded.has(txn.id));
  }
  return {
    ledgers,
    transactionsByMonth,
    allRowsByMonth,
    assignmentMonthCount: assignmentMonths.length
  };
}

async function computeMonthState(
  ports: WorkerPorts,
  store: FinanceStore,
  month: string
): Promise<{
  state: BudgetMonthState;
  monthRows: TransactionRecord[];
  assignmentMonthCount: number;
}> {
  const { allRowsByMonth, assignmentMonthCount, ...input } = await loadDerivationInput(store);
  // Inject the requested month into the derivation union when it has no data
  // of its own: the derivation then rolls carry/TBB forward into it (or
  // yields the all-zero state when there is no data at all).
  if (!input.ledgers[month] && !input.transactionsByMonth[month]) {
    input.ledgers[month] = { assignments: {} };
  }
  const core = deriveBudgetMonths(input)[month]!;
  return {
    state: { computedAt: ports.now().toISOString(), ...core },
    monthRows: allRowsByMonth[month] ?? [],
    assignmentMonthCount
  };
}

export const budgetStatusHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const store = await ports.store();
  const { state, monthRows, assignmentMonthCount } = await computeMonthState(ports, store, month);
  const accounts = await store.listAccounts();
  const itemStatus = new Map<string, string>();
  for (const account of accounts) {
    if (!itemStatus.has(account.itemId)) {
      itemStatus.set(account.itemId, (await store.getItem(account.itemId))?.status ?? "error");
    }
  }
  // The same rows the Transactions screen counts under Needs a look.
  const needsLookCount = monthRows.filter((txn) => txn.reviewState === "needs_look").length;
  // Taxonomy rides along so the web budget screen renders names and group
  // order from a single call (same shape transactions.query ships).
  const categories = (await loadCategories(ports)).map((category) => ({
    ...category,
    tableGroup: tableGroupFor(category.group)
  }));
  return {
    month,
    state,
    categories,
    hasBank: accounts.length > 0,
    hasBudget: assignmentMonthCount > 0,
    readyToAssignCents: readyToAssignCents(accounts, state.categories),
    needsLookCount,
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      name: account.name,
      balanceCents: signedBalanceCents(account),
      asOf: account.updatedAt,
      stale: itemStatus.get(account.itemId) !== "connected"
    }))
  };
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
  const { state } = await computeMonthState(ports, store, month);
  const assigned = (await store.getLedger(month))?.assignments ?? {};
  const toBefore = assigned[toCategoryId] ?? 0;
  let fromBefore: number | null = null;
  if (fromCategoryId === READY_TO_ASSIGN) {
    const ready = readyToAssignCents(await store.listAccounts(), state.categories);
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
    const results: Record<string, unknown>[] = [];
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
      results.push(
        await applyAssignment(
          ports,
          { month, categoryId: ids[i] as string, amountCents },
          "user",
          liveIds
        )
      );
    }
    return { status: "ok", applied: results.length };
  }

  const categoryId = readString(command, "categoryId", { required: true });
  const amountCents = readInt(command, "amountCents", {
    required: true,
    min: -AMOUNT_BOUND,
    max: AMOUNT_BOUND
  });
  return applyAssignment(ports, { month, categoryId, amountCents }, "user", liveIds);
};
