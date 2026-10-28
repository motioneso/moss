import {
  budgetRows,
  deriveBudgetMonths,
  effectiveTransferIds,
  fundingAt,
  budgetAccount,
  readyToAssignCents,
  safeCents,
  signedBalanceCents,
  MANUAL_CURRENCIES,
  type BudgetLedger,
  type BudgetPolicy,
  type FinanceStore,
  type TransactionRecord
} from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readBool } from "../validate.js";
import { currency, today } from "./manual-ledger.js";

export async function requireBudgetPolicy(store: FinanceStore): Promise<BudgetPolicy> {
  if (!store.budgetPolicy)
    throw new InputError(
      "storage_upgrade_required",
      "Complete Finance storage migration before budgeting"
    );
  const policy = await store.budgetPolicy.get();
  if (!policy)
    throw new InputError(
      "budget_currency_required",
      "Choose and review the working currency on Budget first"
    );
  return policy;
}
export const budgetConfigureHandler: ToolFactory = (ports) => async (input) => {
  const store = await ports.store();
  if (!store.budgetPolicy)
    throw new InputError(
      "storage_upgrade_required",
      "Complete Finance storage migration before budgeting"
    );
  const code = currency(input);
  const acknowledgeLegacy = readBool(input, "acknowledgeLegacy", { required: true });
  const outcome = await store.budgetPolicy.configure(
    code,
    acknowledgeLegacy,
    ports.now().toISOString()
  );
  if (outcome === "legacy_review_required")
    throw new InputError(
      "legacy_review_required",
      "Review how your existing assignment amounts will be interpreted"
    );
  if (outcome === "conflict")
    throw new InputError(
      "budget_currency_fixed",
      "A working currency is already selected; refresh Budget"
    );
  return { status: "ok", isoCurrency: code, unchanged: outcome === "unchanged" };
};

export async function budgetContext(ports: WorkerPorts, store: FinanceStore, month: string) {
  const accounts = await store.listAccounts();
  const assignmentMonths = await store.listAssignmentMonths();
  const policy = await store.budgetPolicy?.get();
  if (!policy) {
    const legacyMonths = [];
    for (const month of assignmentMonths) {
      const assignments = (await store.getLedger(month))?.assignments ?? {};
      legacyMonths.push({
        month,
        totalCents: Object.values(assignments)
          .reduce((sum, cents) => sum + BigInt(safeCents(cents)), 0n)
          .toString()
      });
    }
    return {
      legacyMonths,
      legacyDraft: (await store.getLatestDraft())?.status === "open",
      setupRequired: true as const,
      storageReady: Boolean(store.budgetPolicy),
      legacyMonthCount: assignmentMonths.length,
      currencies: [...MANUAL_CURRENCIES],
      accountCurrencies: [...new Set(accounts.map((a) => a.isoCurrency))].sort(),
      hasBank: accounts.length > 0,
      hasBudget: assignmentMonths.length > 0,
      isoCurrency: null,
      currentMonth: today(ports).slice(0, 7)
    };
  }
  const date = today(ports);
  const fundingAccounts = accounts.filter((account) => budgetAccount(account, policy.isoCurrency));
  const ledgers: Record<string, BudgetLedger> = {};
  for (const key of assignmentMonths) ledgers[key] = (await store.getLedger(key))!;
  const all: TransactionRecord[] = [];
  for (const key of await store.listTransactionMonths())
    all.push(...(await store.listMonthTransactions(key)));
  const rows = budgetRows(accounts, policy.isoCurrency, all, date);
  const excluded = effectiveTransferIds(rows);
  const transactionsByMonth: Record<string, TransactionRecord[]> = {};
  for (const row of rows) {
    if (excluded.has(row.id)) continue;
    (transactionsByMonth[row.date.slice(0, 7)] ??= []).push(row);
  }
  ledgers[month] ??= { assignments: {} };
  const state = {
    computedAt: ports.now().toISOString(),
    ...deriveBudgetMonths({ ledgers, transactionsByMonth })[month]!
  };
  const balances = await fundingAt(store, fundingAccounts, all, month, date);
  const readyUnavailable =
    month > date.slice(0, 7)
      ? "future_month"
      : balances.some((a) => a.balanceCents === null)
        ? "missing_history"
        : null;
  const futureReservedCents =
    month === date.slice(0, 7)
      ? safeCents(
          Object.entries(ledgers)
            .filter(([key]) => key > month)
            .reduce(
              (sum, [, ledger]) =>
                sum +
                Object.entries(ledger.assignments)
                  .filter(([id]) => id !== "income" && id !== "transfers")
                  .reduce((n, [, cents]) => n + BigInt(Math.max(0, safeCents(cents))), 0n),
              0n
            )
        )
      : 0;
  const ready = readyUnavailable
    ? null
    : safeCents(
        BigInt(
          readyToAssignCents(
            balances.map((a) => ({ ...a, balanceCents: a.balanceCents! })),
            state.categories
          )
        ) - BigInt(futureReservedCents)
      );
  const staleIds = new Set<string>();
  for (const account of fundingAccounts) {
    if (
      account.source !== "manual" &&
      (!account.itemId || (await store.getItem(account.itemId))?.status !== "connected")
    )
      staleIds.add(account.accountId);
  }
  const ids = new Set(fundingAccounts.map((a) => a.accountId));
  return {
    setupRequired: false as const,
    isoCurrency: policy.isoCurrency,
    revision: policy.revision,
    currentMonth: date.slice(0, 7),
    hasBank: accounts.length > 0,
    hasBudget: assignmentMonths.length > 0,
    state,
    readyToAssignCents: ready,
    readyUnavailable,
    futureReservedCents,
    excludedAccountCount: accounts.length - fundingAccounts.length,
    pendingCount: all.filter(
      (row) =>
        ids.has(row.accountId) &&
        row.isoCurrency === policy.isoCurrency &&
        row.pending &&
        row.date.slice(0, 7) === month
    ).length,
    needsLookCount: rows.filter(
      (row) => row.date.slice(0, 7) === month && row.reviewState === "needs_look"
    ).length,
    accounts: balances.map((a) => ({
      ...a,
      balanceCents:
        a.balanceCents === null ? null : signedBalanceCents({ ...a, balanceCents: a.balanceCents }),
      stale: staleIds.has(a.accountId)
    }))
  };
}
