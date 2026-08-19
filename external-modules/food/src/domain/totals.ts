// external-modules/food/src/domain/totals.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 3 + §3 determinism boundary):
// computeDailyTotals — the only place daily nutrient sums are computed.
// Binding rule: a nutrient total is null unless at least one estimated meal
// contributed a non-null value for it. Never COALESCE a missing nutrient to
// 0 — a half-estimated day must not read as a low-calorie day (test case 4,
// plan §4 Task 7).

import type { DailyTotals, Meal, Nutrients } from "./meal.js";

const NUTRIENT_KEYS = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const satisfies readonly (keyof Nutrients)[];

/**
 * Sums only meals whose estimate is complete (estimateState === "estimated"
 * with a non-null nutrients record). Any other meal in the day — pending,
 * needs_details, or failed — flips `incomplete` and is counted in
 * `mealsWithoutEstimate`, but never contributes a zero to the sums.
 *
 * `localDate` is passed in rather than read off `meals[0]`: an empty day is
 * a real case — the user opens a date they logged nothing on — and it must
 * still name its date (plan §4 Task 7 test 14). Callers pre-filter `meals`
 * to that one day, per store/sql.ts's listMealsForLocalDate.
 */
export function computeDailyTotals(localDate: string, meals: readonly Meal[]): DailyTotals {
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

  let incomplete = false;
  let mealsWithoutEstimate = 0;

  for (const meal of meals) {
    if (meal.estimateState !== "estimated" || meal.nutrients === null) {
      incomplete = true;
      mealsWithoutEstimate += 1;
      continue;
    }
    for (const key of NUTRIENT_KEYS) {
      const value = meal.nutrients[key];
      if (value === null) continue; // this meal is estimated but this one nutrient is unknown
      sums[key] += value;
      contributed[key] = true;
    }
  }

  const nutrients: Nutrients = {
    caloriesKcal: contributed.caloriesKcal ? sums.caloriesKcal : null,
    proteinG: contributed.proteinG ? sums.proteinG : null,
    carbohydratesG: contributed.carbohydratesG ? sums.carbohydratesG : null,
    fatG: contributed.fatG ? sums.fatG : null,
    fiberG: contributed.fiberG ? sums.fiberG : null,
    sugarG: contributed.sugarG ? sums.sugarG : null,
    sodiumMg: contributed.sodiumMg ? sums.sodiumMg : null
  };

  return { localDate, nutrients, incomplete, mealsWithoutEstimate };
}
