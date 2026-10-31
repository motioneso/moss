import { FLEX_POOL, leaveFlexAssignments, type FlexPolicy } from "../../domain/flex.js";
import { isCalendarMonth, safeCents } from "../../domain/values.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import {
  budgetContext,
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
import { loadCategories } from "./feed.js";
import { today } from "./manual-ledger.js";
import { storedFlexTotal } from "./flex-guards.js";
const monthInput = (input: Record<string, unknown>) => {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("Choose a valid budget month");
  return month;
};
function ids(input: Record<string, unknown>, key: string) {
  const value = input[key] ?? [];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((id) => typeof id !== "string" || id.length > 128) ||
    new Set(value).size !== value.length
  )
    throw new InputError("Choose at most 100 unique category ids");
  return value as string[];
}
async function prepare(ports: WorkerPorts, input: Record<string, unknown>) {
  const month = monthInput(input);
  if (month !== today(ports).slice(0, 7))
    throw new InputError(
      "current_month_required",
      "Change budget mode in the current month; past policies are preserved"
    );
  const mode = readEnum(input, "mode", ["flex", "envelopes"] as const, { required: true });
  const store = await ports.store();
  if (!store.flex)
    throw new InputError("storage_upgrade_required", "Update Finance before changing budget mode");
  const before = await budgetContext(ports, store, month);
  if (before.setupRequired || before.readyToAssignCents === null)
    throw new InputError("Review your currency and account balances before changing mode");
  const current = before.flex;
  const all = await loadCategories(ports);
  const live = new Set(
    all.filter((c) => !c.archived && c.id !== "income" && c.id !== "transfers").map((c) => c.id)
  );
  for (const future of (await store.listAssignmentMonths()).filter((m) => m > month))
    if (Object.values((await store.getLedger(future))?.assignments ?? {}).some((n) => n !== 0))
      throw new InputError(
        "future_assignments",
        "Clear nonzero future assignments before changing mode; they will not be rewritten"
      );
  if ((await store.getLatestDraft())?.status === "open")
    throw new InputError("open_draft", "Finish your open first-budget draft before changing mode");
  let assignments: { categoryId: string; amountCents: number }[] = [];
  let policy: FlexPolicy;
  let requiresDistribution = false;
  if (mode === "flex") {
    if (current?.active) throw new InputError("Leave the current pool before changing its members");
    const flexIds = ids(input, "flexIds"),
      nonMonthlyIds = ids(input, "nonMonthlyIds");
    if (
      !flexIds.length ||
      [...flexIds, ...nonMonthlyIds].some((id) => !live.has(id)) ||
      nonMonthlyIds.some((id) => flexIds.includes(id))
    )
      throw new InputError(
        "Choose live expense categories in distinct groups, including at least one flexible category"
      );
    if (
      [
        ...((await store.targets?.forMonth(month)) ?? []),
        ...((await store.targets?.versions?.()) ?? []).filter(
          (t) => t.effectiveMonth >= month && t.kind !== "removed"
        )
      ].some((t) => flexIds.includes(t.categoryId))
    )
      throw new InputError(
        "flex_target",
        "Remove or move targets on proposed flexible categories before pooling their money"
      );
    policy = { month, active: true, flexIds, nonMonthlyIds };
  } else {
    if (!current?.active) throw new InputError("This month is already using category envelopes");
    policy = { month, active: false, flexIds: [], nonMonthlyIds: [] };
    const available = before.state.categories[FLEX_POOL]?.availableCents ?? 0;
    if (available < 0)
      throw new InputError("Cover the flexible pool's overspending before leaving");
    const envelope = await budgetContext(ports, store, month, policy);
    if (envelope.setupRequired) throw staleBudget();
    if (input.distribution === undefined) requiresDistribution = true;
    else {
      const values = input.distribution;
      if (typeof values !== "object" || values === null || Array.isArray(values))
        throw new InputError("Choose an available amount for every flexible category");
      const amounts: Record<string, number> = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          readInt({ value }, "value", { required: true, min: 0, max: Number.MAX_SAFE_INTEGER })
        ])
      );
      try {
        assignments = leaveFlexAssignments(
          current.flexIds,
          amounts,
          envelope.state.categories,
          available
        );
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : "Review your destinations");
      }
    }
  }
  const after = await budgetContext(ports, store, month, policy);
  if (after.setupRequired) throw staleBudget();
  // Destination assignment effects are calculated from the same immutable review. Preview the
  // final available totals directly; no speculative amounts replace the persisted Budget screen.
  const availableCents =
    mode === "flex"
      ? (after.state.categories[FLEX_POOL]?.availableCents ?? 0)
      : (before.state.categories[FLEX_POOL]?.availableCents ?? 0);
  requireSameReview(before, await requireBudgetPolicy(store));
  return {
    store,
    before,
    policy,
    assignments,
    requiresDistribution,
    view: {
      status: "ok",
      month,
      mode,
      isoCurrency: before.isoCurrency,
      revision: before.revision,
      fingerprint: before.fingerprint,
      requiresDistribution,
      poolAvailableCents: availableCents,
      poolAssignedCents:
        mode === "flex"
          ? (after.state.categories[FLEX_POOL]?.assignedCents ?? 0)
          : (before.state.categories[FLEX_POOL]?.assignedCents ?? 0),
      poolActivityCents:
        mode === "flex"
          ? (after.state.categories[FLEX_POOL]?.activityCents ?? 0)
          : (before.state.categories[FLEX_POOL]?.activityCents ?? 0),
      readyBeforeCents: before.readyToAssignCents,
      readyAfterCents: mode === "flex" ? after.readyToAssignCents : before.readyToAssignCents,
      members: (mode === "flex" ? policy.flexIds : current!.flexIds).map((id) => ({
        id,
        name: all.find((c) => c.id === id)?.name ?? id
      })),
      assignments
    }
  };
}
export const flexPreviewHandler: ToolFactory = (ports) => async (input) =>
  (await prepare(ports, input)).view;
export const flexConfigureHandler: ToolFactory = (ports) => async (input) => {
  const expected = readBudgetReview(input);
  const plan = await prepare(ports, input);
  requireSameReview(expected, plan.before);
  if (plan.requiresDistribution)
    throw new InputError("Choose destinations for all available pool money before leaving");
  if (
    !(await plan.store.commitBudgetChange({
      expected,
      month: plan.policy.month,
      assignments: plan.assignments,
      flexPolicy: plan.policy,
      activity: [
        {
          actor: "user",
          kind: "flex.mode",
          params: { month: plan.policy.month, mode: plan.policy.active ? "flex" : "envelopes" }
        }
      ]
    }))
  )
    throw staleBudget();
  return {
    status: "ok",
    month: plan.policy.month,
    mode: plan.policy.active ? "flex" : "envelopes"
  };
};
export const flexAssignHandler: ToolFactory = (ports) => async (input) => {
  const month = monthInput(input),
    amountCents = readInt(input, "amountCents", { required: true, min: 0, max: 100000000 }),
    previous = readInt(input, "previousCents", {
      required: true,
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER
    });
  const expected = readBudgetReview(input),
    store = await ports.store();
  const context = await budgetContext(ports, store, month);
  if (context.setupRequired || !context.flex?.active)
    throw new InputError("Flexible mode is not active for this month");
  requireSameReview(expected, context);
  if ((context.state.categories[FLEX_POOL]?.assignedCents ?? 0) !== previous) throw staleBudget();
  const ledger = (await store.getLedger(month))?.assignments ?? {};
  const delta = storedFlexTotal(FLEX_POOL, amountCents, ledger, context.flex);
  if (
    !(await store.commitBudgetChange({
      expected,
      month,
      assignments: [{ categoryId: FLEX_POOL, amountCents: delta }],
      activity: [
        {
          actor: "user",
          kind: "flex.assign",
          params: { month, amountCents, previousCents: previous }
        }
      ]
    }))
  )
    throw staleBudget();
  return { status: "ok", month, assignedCents: safeCents(amountCents) };
};
