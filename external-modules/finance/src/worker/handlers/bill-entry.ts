import type { ToolFactory } from "../registry.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { currency, date, digest, id, today } from "./manual-ledger.js";
import { billMatchWindow, billOccurrences } from "../../domain/recurrence.js";
import { isCalendarDate, safeCents } from "../../domain/values.js";
import { loadCategories } from "./feed.js";
import {
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
function intent(input: Record<string, unknown>, current: string) {
  const planId = readString(input, "planId", { required: true }).toLowerCase();
  const dueDate = readString(input, "dueDate", { required: true });
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(planId) ||
    !isCalendarDate(dueDate)
  )
    throw new InputError("invalid_occurrence", "Choose a saved bill occurrence");
  const name = readString(input, "name", { required: true, maxBytes: 640 }).trim();
  if (!name || name.length > 160) throw new InputError("Use the saved bill name");
  return {
    id: id(input, "operationId"),
    planId,
    dueDate,
    accountId: readString(input, "accountId", { required: true, maxBytes: 128 }),
    categoryId: readString(input, "categoryId", { required: true, maxBytes: 256 }),
    name,
    isoCurrency: currency(input),
    date: date(input, "date", current),
    amountCents: readInt(input, "amountCents", {
      required: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER
    }),
    cleared: readBool(input, "cleared", { required: true })
  };
}
async function prepare(
  ports: Parameters<ToolFactory>[0],
  input: Record<string, unknown>,
  values: ReturnType<typeof intent>
) {
  const store = await ports.store(),
    review = readBudgetReview(input);
  const policy = await requireBudgetPolicy(store);
  requireSameReview(review, policy);
  if (policy.isoCurrency !== values.isoCurrency)
    throw new InputError(
      "bill_entry_account",
      "Use the current working budget currency for bill entries"
    );
  if (!store.bills?.recordEntry || !store.accountLifecycle)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance before recording a bill entry"
    );
  const plan = (await store.bills.plans()).find((p) => p.id === values.planId);
  if (
    !plan ||
    plan.accountId !== values.accountId ||
    plan.name !== values.name ||
    plan.isoCurrency !== values.isoCurrency ||
    plan.categoryId !== values.categoryId ||
    !billOccurrences(plan, values.dueDate, values.dueDate).includes(values.dueDate)
  )
    throw new InputError(
      "invalid_occurrence",
      "Refresh the bill and use its saved account, category and name"
    );
  const adjustment = (await store.billAdjustments?.rows(values.dueDate, values.dueDate))?.find(
    (a) => a.planId === values.planId && a.dueDate === values.dueDate
  );
  const plannedDate = adjustment?.plannedDate ?? values.dueDate;
  const current = today(ports);
  if (plannedDate > current)
    throw new InputError("bill_not_due", "Record this bill only once it is due");
  if (
    (await store.bills.decisions(values.dueDate, values.dueDate)).some(
      (d) => d.planId === values.planId && d.dueDate === values.dueDate
    )
  )
    throw new InputError(
      "bill_already_reviewed",
      "Check this bill's existing review before recording an entry"
    );
  const account = await store.getAccount(values.accountId);
  const ledger = await store.accountLifecycle.review(values.accountId, current);
  if (
    !account ||
    account.source !== "manual" ||
    account.archivedAt ||
    !ledger ||
    ledger.archivedAt ||
    account.isoCurrency !== values.isoCurrency
  )
    throw new InputError(
      "bill_entry_account",
      "Choose an active manual account in the bill currency"
    );
  if (
    values.date < ledger.openingDate ||
    (ledger.lastReconciledDate && values.date <= ledger.lastReconciledDate)
  )
    throw new InputError(
      "bill_entry_period",
      "Choose a date after the last reconciled statement and on or after opening"
    );
  if (ledger.blockers.includes("invalid_ledger") || ledger.blockers.includes("future_entries"))
    throw new InputError(
      "bill_entry_account",
      "Review this account's ledger before adding an expense"
    );
  const category = (await loadCategories(ports)).find(
    (c) =>
      c.id === values.categoryId &&
      !c.archived &&
      c.group.toLowerCase() !== "income" &&
      c.id !== "income" &&
      c.id !== "transfers"
  );
  if (!category)
    throw new InputError("invalid_category", "Choose a current expense category on the bill");
  const debt = ["credit", "loan"].includes(account.type);
  let after: number;
  try {
    after = safeCents(
      BigInt(account.balanceCents) + (debt ? 1n : -1n) * BigInt(values.amountCents)
    );
  } catch {
    throw new InputError(
      "bill_entry_overflow",
      "The resulting account balance exceeds supported precision"
    );
  }
  const window = billMatchWindow(values.date, values.date);
  const months = new Set([window.from.slice(0, 7), values.date.slice(0, 7), window.to.slice(0, 7)]);
  const candidates = [];
  for (const month of [...months].sort())
    for (const t of await store.listMonthTransactions(month)) {
      if (
        t.accountId === values.accountId &&
        t.isoCurrency === values.isoCurrency &&
        !t.pending &&
        t.amountCents === values.amountCents &&
        t.date >= window.from &&
        t.date <= window.to &&
        t.categoryId !== "income" &&
        t.categoryId !== "transfers"
      )
        candidates.push({ id: t.id, date: t.date, name: t.name, amountCents: t.amountCents });
    }
  requireSameReview(review, await requireBudgetPolicy(store));
  return {
    store,
    review,
    account,
    category,
    debt,
    after,
    plannedDate,
    expectedCents: adjustment?.amountCents ?? plan.amountCents,
    candidates
  };
}
export const billEntryPreviewHandler: ToolFactory = (ports) => async (input) => {
  const values = intent(input, today(ports)),
    p = await prepare(ports, input, values);
  return {
    status: "ok",
    revision: p.review.revision,
    fingerprint: p.review.fingerprint,
    accountName: p.account.name,
    categoryName: p.category.name,
    debt: p.debt,
    beforeCents: p.account.balanceCents,
    afterCents: p.after,
    plannedDate: p.plannedDate,
    expectedCents: p.expectedCents,
    canRecord: p.candidates.length === 0,
    candidateCount: p.candidates.length,
    candidates: p.candidates.slice(0, 20)
  };
};
export const billEntryRecordHandler: ToolFactory = (ports) => async (input) => {
  const current = today(ports),
    values = intent(input, current),
    hash = digest(values);
  const store = await ports.store();
  if (!store.bills?.entryReplay || !store.bills.recordEntry)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance before recording a bill entry"
    );
  const replay = await store.bills.entryReplay(values.id, hash, values.planId, values.dueDate);
  if (replay === "unchanged") return { status: "ok", id: values.id, unchanged: true };
  if (replay === "conflict")
    throw new InputError(
      "bill_entry_conflict",
      "Check the saved entry and bill match before starting another operation"
    );
  const p = await prepare(ports, input, values);
  if (p.candidates.length)
    throw new InputError(
      "bill_entry_duplicate",
      "Review the existing posted expense before recording another"
    );
  if (
    !(await store.bills.recordEntry({
      ...values,
      notes: "",
      digest: hash,
      today: current,
      review: p.review,
      at: ports.now().toISOString()
    }))
  )
    throw staleBudget();
  return { status: "ok", id: values.id, unchanged: false };
};
