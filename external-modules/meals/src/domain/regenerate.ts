// external-modules/meals/src/domain/regenerate.ts
//
// Which meals a regenerate replaces. One rule serves the tool, the plan view's count and the
// page, so the number shown before the click is the number the click replaces.

interface ReplaceableMeal {
  readonly kind: "recipe" | "text";
  readonly status: "pending" | "writing" | "ready" | "failed";
  readonly locked: boolean;
  readonly cookedAt: string | null;
}

/**
 * A written or failed recipe meal that is neither locked nor cooked. Text meals, locked meals,
 * cooked meals and meals still waiting to be written are left as they are.
 */
export function isReplaceable(meal: ReplaceableMeal): boolean {
  return (
    meal.kind === "recipe" &&
    !meal.locked &&
    meal.cookedAt === null &&
    (meal.status === "ready" || meal.status === "failed")
  );
}
