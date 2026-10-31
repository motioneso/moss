import { projectBillOccurrences } from "../../domain/bill-adjustments.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import { isCalendarDate } from "../../domain/values.js";
import { billMatchWindow, billOccurrences } from "../../domain/recurrence.js";
import {
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
import { loadCategories } from "./feed.js";
import { today } from "./manual-ledger.js";
const uuid = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw new InputError("A valid plan identity is required");
  return value;
};
const date = (value: string) => {
  if (!isCalendarDate(value)) throw new InputError("Choose a valid calendar date");
  return value;
};
export const billsReadHandler: ToolFactory = (ports) => async (input) => {
  const from = date(readString(input, "from", { required: true })),
    to = date(readString(input, "to", { required: true }));
  // Validate even if there are no plans, and cap output before collecting private records.
  const matchWindow = billMatchWindow(from, to);
  const store = await ports.store();
  if (store.budgetPolicy && !(await store.budgetPolicy.get()))
    return { status: "ok", setupRequired: true };
  const policy = await requireBudgetPolicy(store);
  if (!store.bills)
    throw new InputError("storage_upgrade_required", "Update Finance before using bills");
  const plans = await store.bills.plans();
  if (plans.length > 500)
    throw new InputError("Narrow the saved bill list before projecting more than 500 plans");
  const adjustments = (await store.billAdjustments?.rows(from, to)) ?? [];
  let projected;
  try {
    projected = projectBillOccurrences(plans, adjustments, from, to);
  } catch {
    throw new InputError(
      "invalid_bill_projection",
      "Use a shorter window or check saved bill changes before projecting this range"
    );
  }
  const decisions = await store.bills.decisions(
    from,
    to,
    adjustments.map((a) => a.dueDate)
  );
  const accounts = (await store.listAccounts()).filter((a) => a.isoCurrency === policy.isoCurrency);
  const categories = (await loadCategories(ports)).filter(
    (c) => !c.archived && c.id !== "income" && c.id !== "transfers"
  );
  const transactions: {
    id: string;
    accountId: string;
    date: string;
    name: string;
    amountCents: number;
  }[] = [];
  const months = new Set<string>([
    ...(await store.listTransactionMonths()),
    from.slice(0, 7),
    to.slice(0, 7),
    matchWindow.from.slice(0, 7),
    matchWindow.to.slice(0, 7)
  ]);
  for (const month of [...months].sort()) {
    if (month < matchWindow.from.slice(0, 7) || month > matchWindow.to.slice(0, 7)) continue;
    for (const t of await store.listMonthTransactions(month))
      if (
        t.date >= matchWindow.from &&
        t.date <= matchWindow.to &&
        !t.pending &&
        t.amountCents > 0 &&
        t.isoCurrency === policy.isoCurrency &&
        t.categoryId !== "income" &&
        t.categoryId !== "transfers"
      )
        transactions.push({
          id: t.id,
          accountId: t.accountId,
          date: t.date,
          name: t.name,
          amountCents: t.amountCents
        });
  }
  if (transactions.length > 1000)
    throw new InputError(
      "Use a shorter window to review bill matches, including seven days either side"
    );
  const used = new Set(
    store.billAdjustments
      ? await store.billAdjustments.claimedTransactionIds(transactions.map((t) => t.id))
      : decisions.map((d) => d.transactionId).filter(Boolean)
  );
  const occurrences = projected.map((o) => {
    const decision = decisions.find((d) => d.planId === o.planId && d.dueDate === o.dueDate);
    const account = accounts.find((a) => a.accountId === o.accountId);
    return {
      ...o,
      canAdjust: Boolean(store.billAdjustments && account && !account.archivedAt && !decision),
      canRecordEntry: Boolean(
        store.bills?.recordEntry &&
        account?.source === "manual" &&
        !account.archivedAt &&
        !decision &&
        o.plannedDate <= today(ports) &&
        categories.some((c) => c.id === o.categoryId && c.group.toLowerCase() !== "income")
      ),
      state:
        decision?.state === "matched"
          ? decision.matchedValid
            ? "posted"
            : "review"
          : (decision?.state ?? "projected"),
      actualCents: decision?.actualCents ?? null,
      transactionId: decision?.transactionId ?? null
    };
  });
  requireSameReview(policy, await requireBudgetPolicy(store));
  return {
    status: "ok",
    today: today(ports),
    matchFrom: matchWindow.from,
    matchTo: matchWindow.to,
    isoCurrency: policy.isoCurrency,
    revision: policy.revision,
    fingerprint: policy.fingerprint,
    plans,
    occurrences,
    supportsAdjustments: Boolean(store.billAdjustments),
    accounts: accounts.map((a) => ({ accountId: a.accountId, name: a.name })),
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    transactions: transactions.filter((t) => !used.has(t.id))
  };
};
export const billCreateHandler: ToolFactory = (ports) => async (input) => {
  const id = uuid(readString(input, "id", { required: true }));
  const name = readString(input, "name", { required: true, maxBytes: 640 }).trim();
  if (!name || name.length > 160)
    throw new InputError("Use a bill name between 1 and 160 characters");
  const accountId = readString(input, "accountId", { required: true }),
    categoryId = readString(input, "categoryId", { required: true });
  const amountCents = readInt(input, "amountCents", { required: true, min: 1, max: 100000000 });
  const anchorDate = date(readString(input, "anchorDate", { required: true }));
  const cadence = readEnum(
    input,
    "cadence",
    ["once", "weekly", "fortnightly", "monthly", "yearly"] as const,
    { required: true }
  );
  const expected = readBudgetReview(input);
  const store = await ports.store();
  const policy = await requireBudgetPolicy(store);
  requireSameReview(expected, policy);
  if (!store.bills)
    throw new InputError("storage_upgrade_required", "Update Finance before saving bills");
  if ((await store.bills.plans()).length >= 500)
    throw new InputError("No more than 500 bill plans are supported");
  if (
    !(await store.bills.create(
      {
        id,
        name,
        accountId,
        categoryId,
        amountCents,
        anchorDate,
        cadence,
        isoCurrency: policy.isoCurrency
      },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", id };
};
export const billDecideHandler: ToolFactory = (ports) => async (input) => {
  const planId = uuid(readString(input, "planId", { required: true }));
  const dueDate = date(readString(input, "dueDate", { required: true }));
  const state = readEnum(input, "state", ["skipped", "matched"] as const, { required: true });
  const transactionId = readString(input, "transactionId");
  if ((state === "matched" && !transactionId) || (state === "skipped" && transactionId))
    throw new InputError(
      "Choose one posted transaction for a match, or skip without a transaction"
    );
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.bills)
    throw new InputError("storage_upgrade_required", "Update Finance before reviewing bills");
  const plan = (await store.bills.plans()).find((p) => p.id === planId);
  if (!plan || !billOccurrences(plan, dueDate, dueDate).includes(dueDate))
    throw new InputError("Choose an occurrence in this bill's schedule");
  if (
    !(await store.bills.decide(
      { planId, dueDate, state, transactionId: transactionId ?? null },
      expected,
      ports.now().toISOString()
    ))
  )
    throw staleBudget();
  return { status: "ok", planId, dueDate };
};
export const billStopHandler: ToolFactory = (ports) => async (input) => {
  const id = uuid(readString(input, "id", { required: true })),
    endDate = date(readString(input, "endDate", { required: true }));
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (!store.bills || !(await store.bills.stop(id, endDate, expected, ports.now().toISOString())))
    throw staleBudget();
  return { status: "ok", id };
};

export const billClearHandler: ToolFactory = (ports) => async (input) => {
  const planId = uuid(readString(input, "planId", { required: true })),
    dueDate = date(readString(input, "dueDate", { required: true }));
  const expected = readBudgetReview(input),
    store = await ports.store();
  requireSameReview(expected, await requireBudgetPolicy(store));
  if (
    !store.bills ||
    !(await store.bills.clear(planId, dueDate, expected, ports.now().toISOString()))
  )
    throw staleBudget();
  return { status: "ok", planId, dueDate };
};
