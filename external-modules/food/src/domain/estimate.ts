// external-modules/food/src/domain/estimate.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 3 + §3 determinism boundary):
// EstimatorOutcome — the shape the estimator (Task 5) hands back — and
// validateNutrients, guard 3 of the four-guard determinism boundary: schema
// field descriptions (guard 1) and the prompt's worked example (guard 2)
// live in Task 5's estimator/schema.ts and estimator/run.ts; correction
// diffing (guard 4) lives in store/sql.ts's correctMeal. This file is the
// last line of defence BEFORE anything from a model reaches Postgres.

import type { Nutrients } from "./meal.js";

export interface EstimatorOutcome {
  readonly kind: "estimated" | "needs_details" | "failed";
  readonly nutrients: Nutrients | null;
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

/**
 * Per-nutrient ceiling for a SINGLE MEAL (not a day) — generous enough to
 * cover an outsized meal (a large restaurant feast, a bulking-diet plate)
 * without accepting obvious model nonsense (a five-digit sodium reading, a
 * typo'd extra zero). Chosen, not measured; revisit if the Phase 1 kill gate
 * (plan §6) surfaces real meals this rejects.
 */
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
