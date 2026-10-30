import { deriveCardReserves, cardReadyToAssignCents } from "../../domain/card-reserves.js";
import type { CardReservePolicy, CardReserveAssignment } from "../../domain/card-reserve-store.js";
import { allocations } from "../../domain/splits.js";
import { flexForMonth, type FlexPolicy } from "../../domain/flex.js";
import {
  budgetRows,
  deriveBudgetMonths,
  effectiveTransferIds,
  fundingAt,
  budgetAccount,
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
import { loadCategories } from "./feed.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
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
  if (!policy.taxonomyReady)
    throw new InputError(
      "storage_upgrade_required",
      "Finish Finance category migration before budgeting"
    );
  return policy;
}
export const staleBudget = () =>
  new InputError(
    "stale_budget",
    "The budget or ledger changed. Refresh and review the amounts again before saving."
  );
export function readBudgetReview(input: Record<string, unknown>) {
  const revision = readInt(input, "expectedRevision", {
    required: true,
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  const fingerprint = readString(input, "expectedFingerprint", { required: true });
  if (!/^[a-f0-9]{32}$/.test(fingerprint))
    throw new InputError("Refresh the budget to get a valid review token");
  return { revision, fingerprint };
}
export function requireSameReview(
  expected: { revision: number; fingerprint: string },
  actual: { revision: number; fingerprint: string }
) {
  if (expected.revision !== actual.revision || expected.fingerprint !== actual.fingerprint)
    throw staleBudget();
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
    ports.now().toISOString(),
    await loadCategories(ports)
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

export async function budgetContext(
  ports: WorkerPorts,
  store: FinanceStore,
  month: string,
  flexOverride?: FlexPolicy,
  cardOverride?: { policy?: CardReservePolicy; assignment: CardReserveAssignment }
) {
  const policy = await store.budgetPolicy?.get();
  const accounts = await store.listAccounts();
  const assignmentMonths = await store.listAssignmentMonths();
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
  if (!policy.taxonomyReady)
    throw new InputError(
      "storage_upgrade_required",
      "Finish Finance category migration before budgeting"
    );
  let flexPolicies = (await store.flex?.policies()) ?? [];
  if (flexOverride)
    flexPolicies = [...flexPolicies.filter((p) => p.month !== flexOverride.month), flexOverride];
  const flex = flexForMonth(flexPolicies, month);
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
  let cardPolicies = (await store.cardReserves?.policies()) ?? [];
  let cardAssignments = (await store.cardReserves?.assignments()) ?? [];
  if (cardOverride) {
    if (cardOverride.policy) cardPolicies = [...cardPolicies, cardOverride.policy];
    cardAssignments = [
      ...cardAssignments.filter(
        (a) =>
          a.accountId !== cardOverride.assignment.accountId ||
          a.month !== cardOverride.assignment.month
      ),
      cardOverride.assignment
    ];
  }
  for (const key of [
    ...cardPolicies.map((p) => p.effectiveMonth),
    ...cardAssignments.map((a) => a.month)
  ])
    ledgers[key] ??= { assignments: {} };
  const ordinary = deriveBudgetMonths({ ledgers, transactionsByMonth, flexPolicies });
  let payments;
  try {
    payments =
      deriveCardReserves({
        accounts,
        rows,
        policies: cardPolicies,
        assignments: cardAssignments,
        ordinary,
        flexPolicies,
        transferIds: excluded,
        through: date
      })[month] ?? [];
  } catch (error) {
    throw new InputError(
      "card_ledger_review_required",
      error instanceof Error ? error.message : "Review the card ledger before budgeting"
    );
  }
  const state = {
    computedAt: ports.now().toISOString(),
    ...ordinary[month]!
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
            ) +
            cardAssignments
              .filter((a) => a.month > month)
              .reduce((sum, a) => sum + BigInt(Math.max(0, a.assignedCents)), 0n)
        )
      : 0;
  const ready = readyUnavailable
    ? null
    : safeCents(
        BigInt(
          cardReadyToAssignCents(
            balances.map((a) => ({ ...a, balanceCents: a.balanceCents! })),
            state,
            payments
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
  requireSameReview(policy, await requireBudgetPolicy(store));
  return {
    setupRequired: false as const,
    flex,
    cardPayments: payments.map((p) => ({
      ...p,
      name: accounts.find((a) => a.accountId === p.accountId)!.name,
      archived: Boolean(accounts.find((a) => a.accountId === p.accountId)!.archivedAt)
    })),
    cardChoices: accounts
      .filter(
        (a) =>
          a.source === "manual" &&
          a.type === "credit" &&
          a.isoCurrency === policy.isoCurrency &&
          !a.archivedAt &&
          !cardPolicies.some((p) => p.accountId === a.accountId)
      )
      .map((a) => ({ accountId: a.accountId, name: a.name })),
    cardStorageReady: Boolean(store.cardReserves),
    flexDetail: flex?.active
      ? flex.flexIds.map((id) => ({
          id,
          guidanceCents: ledgers[month]?.assignments[id] ?? 0,
          activityCents: safeCents(
            (transactionsByMonth[month] ?? [])
              .flatMap(allocations)
              .filter((t) => t.categoryId === id)
              .reduce((sum, t) => sum + BigInt(t.amountCents), 0n)
          )
        }))
      : [],
    isoCurrency: policy.isoCurrency,
    revision: policy.revision,
    fingerprint: policy.fingerprint,
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
