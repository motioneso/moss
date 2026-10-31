import type { WeeklyTargetPeriod } from "./weekly-targets.js";
import type { BudgetCategoryState } from "./envelope.js";
import type { TargetProgress } from "./targets.js";
import { safeCents } from "./values.js";
const ASSIGNMENT_BOUND = 100000000n;
export interface TargetFundingLine {
  categoryId: string;
  name: string;
  kind: TargetProgress["kind"];
  weekly?: WeeklyTargetPeriod;
  dueDate: string | null;
  previousCents: number;
  amountCents: number;
  newAssignedCents: number | null;
  unavailableReason: "archived" | "pooled" | "reached" | "assignment_limit" | null;
}
export class TargetFundingError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
/** Ready money does not erase a negative category; ask for that repair first. */
export function hasTargetFundingOverspending(
  state: Readonly<Record<string, BudgetCategoryState>>
): boolean {
  return Object.entries(state).some(
    ([id, row]) => id !== "income" && id !== "transfers" && safeCents(row.availableCents) < 0
  );
}
/** Suggestions remain separate from allocations; a caller must select and confirm them. */
export function targetFundingLines(
  targets: readonly TargetProgress[],
  state: Readonly<Record<string, BudgetCategoryState>>,
  categories: readonly { id: string; name: string; archived?: boolean }[],
  pooledIds: readonly string[]
): TargetFundingLine[] {
  if (new Set(targets.map((t) => t.categoryId)).size !== targets.length)
    throw new TargetFundingError("invalid_targets", "Check duplicate saved target categories");
  return targets.map((target) => {
    const category = categories.find((c) => c.id === target.categoryId);
    const previousCents = safeCents(state[target.categoryId]?.assignedCents ?? 0);
    const amountCents = safeCents(target.suggestedCents);
    const total = BigInt(previousCents) + BigInt(amountCents);
    const withinBound =
      BigInt(amountCents) <= ASSIGNMENT_BOUND &&
      total <= ASSIGNMENT_BOUND &&
      total >= -ASSIGNMENT_BOUND;
    const unavailableReason =
      !category || category.archived || ["income", "transfers"].includes(target.categoryId)
        ? "archived"
        : pooledIds.includes(target.categoryId)
          ? "pooled"
          : target.kind === "removed" || amountCents <= 0
            ? "reached"
            : BigInt(amountCents) > ASSIGNMENT_BOUND ||
                total > ASSIGNMENT_BOUND ||
                total < -ASSIGNMENT_BOUND
              ? "assignment_limit"
              : null;
    return {
      categoryId: target.categoryId,
      name: category?.name ?? "Archived category",
      kind: target.kind,
      ...(target.weekly ? { weekly: target.weekly } : {}),
      dueDate: target.dueDate,
      previousCents,
      amountCents,
      newAssignedCents: withinBound ? safeCents(total) : null,
      unavailableReason
    };
  });
}
export function selectTargetFunding(
  lines: readonly TargetFundingLine[],
  ids: readonly string[],
  amounts: readonly number[],
  readyCents: number | null
) {
  if (
    !ids.length ||
    ids.length > 20 ||
    ids.length !== amounts.length ||
    new Set(ids).size !== ids.length
  )
    throw new TargetFundingError(
      "invalid_selection",
      "Choose one to twenty different targets and their captured amounts"
    );
  const assignments = ids.map((id, i) => {
    const line = lines.find((row) => row.categoryId === id);
    if (!line || line.unavailableReason || line.newAssignedCents === null)
      throw new TargetFundingError(
        "target_unavailable",
        "A selected target is no longer eligible; check the saved budget"
      );
    if (line.amountCents !== amounts[i])
      throw new TargetFundingError(
        "stale_target_guidance",
        "Target guidance changed; check the saved budget before choosing again"
      );
    return {
      categoryId: id,
      amountCents: line.newAssignedCents,
      previousCents: line.previousCents
    };
  });
  const totalCents = safeCents(amounts.reduce((sum, cents) => sum + BigInt(safeCents(cents)), 0n));
  if (readyCents === null)
    throw new TargetFundingError(
      "funding_unavailable",
      "Ready to assign is unavailable; check the saved budget"
    );
  safeCents(readyCents);
  if (totalCents <= 0 || totalCents > readyCents)
    throw new TargetFundingError(
      "not_enough_ready",
      "Choose fewer targets to stay within ready-to-assign money"
    );
  return {
    assignments,
    totalCents,
    readyBeforeCents: readyCents,
    readyAfterCents: safeCents(BigInt(readyCents) - BigInt(totalCents))
  };
}
