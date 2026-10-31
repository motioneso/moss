// external-modules/meals/src/estimator/nutrients.ts
//
// Copied from Food (external-modules/food/src/domain/meal.ts, estimate.ts and totals.ts) so Meals
// does not import another module's internals. Nutrient types, the boundary validator and the
// item sum.

export interface Nutrients {
  readonly caloriesKcal: number | null;
  readonly proteinG: number | null;
  readonly carbohydratesG: number | null;
  readonly fatG: number | null;
  readonly fiberG: number | null;
  readonly sugarG: number | null;
  readonly sodiumMg: number | null;
}

export interface MealItem {
  readonly label: string;
  readonly portionNote: string | null;
  readonly nutrients: Nutrients;
}

export interface EstimatorOutcome {
  readonly kind: "estimated" | "needs_details" | "failed";
  /**
   * The individual foods, each already through validateNutrients. Empty for
   * needs_details and failed.
   */
  readonly items: readonly MealItem[];
  /**
   * Always the sum of `items` (sumItemNutrients) for an estimated meal — never
   * a figure the model produced for the meal as a whole (#1737).
   */
  readonly nutrients: Nutrients | null;
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

const NUTRIENT_CEILINGS: { readonly [K in keyof Nutrients]: number } = {
  caloriesKcal: 5000,
  proteinG: 500,
  carbohydratesG: 1000,
  fatG: 500,
  fiberG: 200,
  sugarG: 500,
  sodiumMg: 20000
};

/** Non-numeric, NaN/Infinity, negative, or out-of-ceiling -> null, never coerced or clamped. */
function sanitizeNutrientValue(value: unknown, ceiling: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > ceiling) return null;
  return value;
}

/**
 * Boundary validator (guard 3). Takes whatever came back from the model
 * (already parsed against the output schema, but still untrusted for
 * VALUES — schema-shape validity says nothing about whether 40000mg of
 * sodium in one meal is plausible) and returns a Nutrients where every field
 * is either a sane number or null. Never throws: a single bad field
 * degrades that field to unknown rather than discarding an otherwise-good
 * estimate. `raw` is deliberately `unknown` — nothing upstream of this
 * function is trusted to have the right shape.
 */
export function validateNutrients(raw: unknown): Nutrients {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    caloriesKcal: sanitizeNutrientValue(record["caloriesKcal"], NUTRIENT_CEILINGS.caloriesKcal),
    proteinG: sanitizeNutrientValue(record["proteinG"], NUTRIENT_CEILINGS.proteinG),
    carbohydratesG: sanitizeNutrientValue(
      record["carbohydratesG"],
      NUTRIENT_CEILINGS.carbohydratesG
    ),
    fatG: sanitizeNutrientValue(record["fatG"], NUTRIENT_CEILINGS.fatG),
    fiberG: sanitizeNutrientValue(record["fiberG"], NUTRIENT_CEILINGS.fiberG),
    sugarG: sanitizeNutrientValue(record["sugarG"], NUTRIENT_CEILINGS.sugarG),
    sodiumMg: sanitizeNutrientValue(record["sodiumMg"], NUTRIENT_CEILINGS.sodiumMg)
  };
}

const NUTRIENT_KEYS = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const satisfies readonly (keyof Nutrients)[];

export function sumItemNutrients(items: readonly MealItem[]): Nutrients {
  const sums: Record<keyof Nutrients, number> = {
    caloriesKcal: 0,
    proteinG: 0,
    carbohydratesG: 0,
    fatG: 0,
    fiberG: 0,
    sugarG: 0,
    sodiumMg: 0
  };
  const contributed: Record<keyof Nutrients, boolean> = {
    caloriesKcal: false,
    proteinG: false,
    carbohydratesG: false,
    fatG: false,
    fiberG: false,
    sugarG: false,
    sodiumMg: false
  };

  for (const item of items) {
    for (const key of NUTRIENT_KEYS) {
      const value = item.nutrients[key];
      if (value === null) continue;
      sums[key] += value;
      contributed[key] = true;
    }
  }

  return {
    caloriesKcal: contributed.caloriesKcal ? sums.caloriesKcal : null,
    proteinG: contributed.proteinG ? sums.proteinG : null,
    carbohydratesG: contributed.carbohydratesG ? sums.carbohydratesG : null,
    fatG: contributed.fatG ? sums.fatG : null,
    fiberG: contributed.fiberG ? sums.fiberG : null,
    sugarG: contributed.sugarG ? sums.sugarG : null,
    sodiumMg: contributed.sodiumMg ? sums.sodiumMg : null
  };
}
