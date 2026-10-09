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
}> {
  const ledgers: Record<string, BudgetLedger> = {};
  for (const month of await store.listAssignmentMonths()) {
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
  const excluded = effectiveTransferIds(Object.values(transactionsByMonth).flat());
  for (const month of Object.keys(transactionsByMonth)) {
    transactionsByMonth[month] = transactionsByMonth[month]!.filter((txn) => !excluded.has(txn.id));
  }
  return { ledgers, transactionsByMonth };
}

async function computeMonthState(
  ports: WorkerPorts,
  store: FinanceStore,
  month: string
): Promise<BudgetMonthState> {
  const input = await loadDerivationInput(store);
  // Inject the requested month into the derivation union when it has no data
  // of its own: the derivation then rolls carry/TBB forward into it (or
  // yields the all-zero state when there is no data at all).
  if (!input.ledgers[month] && !input.transactionsByMonth[month]) {
    input.ledgers[month] = { assignments: {} };
  }
  const core = deriveBudgetMonths(input)[month]!;
  return { computedAt: ports.now().toISOString(), ...core };
}

export const budgetStatusHandler: ToolFactory = (ports) => async (input) => {
  const month = readMonth(input);
  const store = await ports.store();
  const state = await computeMonthState(ports, store, month);
  const accounts = await store.listAccounts();
  const itemStatus = new Map<string, string>();
  for (const account of accounts) {
    if (!itemStatus.has(account.itemId)) {
      itemStatus.set(account.itemId, (await store.getItem(account.itemId))?.status ?? "error");
    }
  }
  // The same rows the Transactions screen counts under Needs a look.
  const monthTransactions = await store.listMonthTransactions(month);
  const needsLookCount = monthTransactions.filter((txn) => txn.reviewState === "needs_look").length;
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
    hasBudget: (await store.listAssignmentMonths()).length > 0,
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

/** Shared write path: validate, then SET the assigned category's total. */
async function applyAssignment(
  ports: WorkerPorts,
  args: { month: string; categoryId: string; amountCents: number }
): Promise<Record<string, unknown>> {
  const live = await loadCategories(ports);
  if (!live.some((category) => category.id === args.categoryId)) {
    throw new InputError("invalid_category", "categoryId is not a live category");
  }

  const store = await ports.store();
  await store.setAssignment(args.month, args.categoryId, args.amountCents);

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
  return applyAssignment(ports, { month, categoryId, amountCents });
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
  const categoryId = readString(command, "categoryId", { required: true });
  const amountCents = readInt(command, "amountCents", {
    required: true,
    min: -AMOUNT_BOUND,
    max: AMOUNT_BOUND
  });
  return applyAssignment(ports, { month, categoryId, amountCents });
};
