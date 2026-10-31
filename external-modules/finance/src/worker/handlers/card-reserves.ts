import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import { isCalendarMonth, safeCents } from "../../domain/values.js";
import {
  budgetContext,
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
import { today } from "./manual-ledger.js";

async function prepare(ports: WorkerPorts, input: Record<string, unknown>) {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month) || month !== today(ports).slice(0, 7))
    throw new InputError(
      "current_month_required",
      "Review card-payment cash in the current month; past months are preserved"
    );
  const accountId = readString(input, "accountId", { required: true, maxBytes: 160 });
  const action = readEnum(input, "action", ["enroll", "fund"] as const, { required: true });
  const amountCents = readInt(input, "availableCents", {
    required: true,
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  const store = await ports.store();
  if (!store.cardReserves)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance before setting up card-payment reserves"
    );
  const account = await store.getAccount(accountId);
  const before = await budgetContext(ports, store, month);
  if (before.setupRequired || before.readyToAssignCents === null)
    throw new InputError("Review your budget currency and account balances first");
  if (
    account?.source !== "manual" ||
    account.type !== "credit" ||
    account.isoCurrency !== before.isoCurrency
  )
    throw new InputError("Choose an owned manual credit card in the budget currency");
  const existing = before.cardPayments.find((c) => c.accountId === accountId);
  if (action === "enroll" && (existing || account.archivedAt))
    throw new InputError("This card is already enrolled or closed; refresh Budget");
  if (action === "fund" && !existing)
    throw new InputError("Set up payment reserves for this card first");
  // Enrollment amount means cash assigned for starting debt. Funding sets available payment cash.
  const assignedCents =
    action === "enroll"
      ? amountCents
      : safeCents(
          BigInt(existing!.assignedCents) + BigInt(amountCents) - BigInt(existing!.availableCents)
        );
  if (account.archivedAt && amountCents > existing!.availableCents)
    throw new InputError(
      "Release excess cash from a closed card; reopen it before increasing reserves"
    );
  const assignment = { accountId, month, assignedCents };
  const policy = action === "enroll" ? { accountId, effectiveMonth: month } : undefined;
  const after = await budgetContext(ports, store, month, undefined, { assignment, policy });
  if (after.setupRequired || after.readyToAssignCents === null) throw staleBudget();
  const payment = after.cardPayments.find((c) => c.accountId === accountId)!;
  if (after.readyToAssignCents < Math.min(0, before.readyToAssignCents))
    throw new InputError(
      "insufficient_ready",
      "Choose less payment cash or release other assignments before saving"
    );
  requireSameReview(before, await requireBudgetPolicy(store));
  return {
    store,
    before,
    assignment,
    policy,
    view: {
      status: "ok",
      month,
      accountId,
      action,
      isoCurrency: before.isoCurrency,
      revision: before.revision,
      fingerprint: before.fingerprint,
      readyBeforeCents: before.readyToAssignCents,
      readyAfterCents: after.readyToAssignCents,
      payment,
      effectiveMonth:
        policy?.effectiveMonth ??
        (await store.cardReserves.policies()).find((p) => p.accountId === accountId)!.effectiveMonth
    }
  };
}
export const cardReservePreviewHandler: ToolFactory = (ports) => async (input) =>
  (await prepare(ports, input)).view;
export const cardReserveSaveHandler: ToolFactory = (ports) => async (input) => {
  const expected = readBudgetReview(input),
    plan = await prepare(ports, input);
  requireSameReview(expected, plan.before);
  if (
    !(await plan.store.commitBudgetChange({
      expected,
      month: plan.assignment.month,
      assignments: [],
      cardPolicy: plan.policy,
      cardAssignment: plan.assignment,
      activity: [
        {
          actor: "user",
          kind: plan.policy ? "card.enroll" : "card.cash-set",
          params: {
            accountId: plan.assignment.accountId,
            month: plan.assignment.month,
            assignedCents: plan.assignment.assignedCents
          }
        }
      ]
    }))
  )
    throw staleBudget();
  return { status: "ok", accountId: plan.assignment.accountId, month: plan.assignment.month };
};
