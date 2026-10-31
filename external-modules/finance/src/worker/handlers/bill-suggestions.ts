// #3877: bill suggestions from the owner's own posted history, and dismissing one.
import {
  suggestBills,
  suggestionPayeeKey,
  SUGGESTION_LOOKBACK_DAYS,
  type SuggestionCharge
} from "../../domain/bill-suggestions.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import { requireBudgetPolicy, requireSameReview } from "./budget-context.js";
import { today } from "./manual-ledger.js";

const CADENCES = ["weekly", "fortnightly", "monthly", "yearly"] as const;
const upgrade = () =>
  new InputError("storage_upgrade_required", "Update Finance before using bill suggestions");
const daysBefore = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

export const billSuggestionsReadHandler: ToolFactory = (ports) => async () => {
  const store = await ports.store();
  if (store.budgetPolicy && !(await store.budgetPolicy.get()))
    return { status: "ok", setupRequired: true };
  const policy = await requireBudgetPolicy(store);
  if (!store.bills || !store.billSuggestions) throw upgrade();
  const day = today(ports),
    from = daysBefore(day, SUGGESTION_LOOKBACK_DAYS);
  const accounts = new Map(
    (await store.listAccounts())
      .filter((a) => a.isoCurrency === policy.isoCurrency && !a.archivedAt)
      .map((a) => [a.accountId, a.name])
  );

  const charges: SuggestionCharge[] = [];
  for (const month of (await store.listTransactionMonths()).sort()) {
    if (month < from.slice(0, 7) || month > day.slice(0, 7)) continue;
    for (const t of await store.listMonthTransactions(month))
      if (
        t.date >= from &&
        t.date <= day &&
        !t.pending &&
        t.amountCents > 0 &&
        t.isoCurrency === policy.isoCurrency &&
        accounts.has(t.accountId) &&
        t.categoryId !== "income" &&
        t.categoryId !== "transfers" &&
        !t.transferId
      )
        charges.push({
          id: t.id,
          accountId: t.accountId,
          date: t.date,
          name: t.name,
          merchant: t.merchant,
          amountCents: t.amountCents,
          categoryId: t.categoryId
        });
  }
  const claimed = new Set(
    (await store.billAdjustments?.claimedTransactionIds(charges.map((c) => c.id))) ?? []
  );
  const plans = (await store.bills.plans()).filter((p) => !p.endDate || p.endDate >= day);
  const suggestions = suggestBills({
    charges: charges.filter((c) => !claimed.has(c.id)),
    plans,
    dismissals: await store.billSuggestions.dismissals(),
    today: day
  });
  requireSameReview(policy, await requireBudgetPolicy(store));
  return {
    status: "ok",
    today: day,
    isoCurrency: policy.isoCurrency,
    suggestions: suggestions.map((s) => ({ ...s, accountName: accounts.get(s.accountId) ?? null }))
  };
};

export const billSuggestionDismissHandler: ToolFactory = (ports) => async (input) => {
  const accountId = readString(input, "accountId", { required: true });
  const payeeKey = readString(input, "payeeKey", { required: true, maxBytes: 640 });
  if (!payeeKey || suggestionPayeeKey(payeeKey) !== payeeKey)
    throw new InputError("Use the payee key from a bill suggestion");
  const cadence = readEnum(input, "cadence", CADENCES, { required: true });
  const amountCents = readInt(input, "amountCents", { required: true, min: 1, max: 100000000 });
  const store = await ports.store();
  if (!store.billSuggestions) throw upgrade();
  if (
    !(await store.billSuggestions.dismiss(
      { accountId, payeeKey, cadence, amountCents },
      ports.now().toISOString()
    ))
  )
    throw new InputError("Choose one of your accounts");
  return { status: "ok", accountId, payeeKey, cadence, amountCents };
};
