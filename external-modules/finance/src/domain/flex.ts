import type { BudgetCategoryState } from "./envelope.js";
import { safeCents } from "./values.js";
export const FLEX_POOL = "moss:flex-pool";
export interface FlexPolicy {
  month: string;
  active: boolean;
  flexIds: string[];
  nonMonthlyIds: string[];
}
export interface FlexStore {
  policies(): Promise<FlexPolicy[]>;
}
export function flexForMonth(policies: readonly FlexPolicy[], month: string): FlexPolicy | null {
  return (
    [...policies]
      .filter((p) => p.month <= month)
      .sort((a, b) => b.month.localeCompare(a.month))[0] ?? null
  );
}
/** Assignments remain canonical; routing turns their old totals into optional member guidance. */
export function routeFlexAmounts(
  input: Record<string, number>,
  policy: FlexPolicy | null
): Record<string, number> {
  if (!policy?.active) return { ...input };
  const output = { ...input };
  let pool = BigInt(safeCents(input[FLEX_POOL] ?? 0));
  for (const id of policy.flexIds) {
    pool += BigInt(safeCents(input[id] ?? 0));
    delete output[id];
  }
  output[FLEX_POOL] = safeCents(pool);
  return output;
}
/** Explicit envelope destinations replace pooled availability; assignment totals must conserve. */
export function leaveFlexAssignments(
  ids: readonly string[],
  available: Record<string, number>,
  envelope: Record<string, BudgetCategoryState>,
  poolAvailable: number
) {
  if (poolAvailable < 0) throw new Error("Cover the flexible pool's overspending before leaving");
  if (
    Object.keys(available).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(available, id))
  )
    throw new Error("Choose an available amount for every flexible category");
  let sum = 0n;
  const assignments = ids.map((categoryId) => {
    const value = safeCents(available[categoryId]!);
    if (value < 0) throw new Error("Available amounts must not be negative");
    sum += BigInt(value);
    const row = envelope[categoryId];
    return {
      categoryId,
      amountCents: safeCents(
        BigInt(value) - BigInt(row?.availableCents ?? 0) + BigInt(row?.assignedCents ?? 0)
      )
    };
  });
  if (sum !== BigInt(safeCents(poolAvailable)))
    throw new Error("Destination amounts must equal the flexible pool's available money");
  const pool = envelope[FLEX_POOL];
  const carry =
    BigInt(pool?.availableCents ?? 0) -
    BigInt(pool?.assignedCents ?? 0) +
    BigInt(pool?.activityCents ?? 0);
  assignments.push({ categoryId: FLEX_POOL, amountCents: safeCents(-carry) });
  return assignments;
}
