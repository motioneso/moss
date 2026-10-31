// external-modules/meals/src/estimator/run.ts
//
// Copied from Food (external-modules/food/src/estimator/run.ts). Turns a description into an
// estimate and never throws. Every AI error and every malformed answer becomes "failed". It asks
// for the economy tier, where Food asks for interactive (spec story 83c).

import type { MealsAi } from "../ai/port.js";
import {
  sumItemNutrients,
  validateNutrients,
  type EstimatorOutcome,
  type MealItem
} from "./nutrients.js";
import { buildEstimatePrompt, ESTIMATE_SCHEMA, parseEstimateResult } from "./schema.js";

const FAILED_OUTCOME: EstimatorOutcome = {
  kind: "failed",
  items: [],
  nutrients: null,
  missingDetails: null,
  clarificationQuestion: null
};

export async function estimateFromDescription(
  ai: MealsAi,
  description: string,
  servingNote: string | null
): Promise<EstimatorOutcome> {
  const result = await ai.generateStructured({
    schema: ESTIMATE_SCHEMA,
    prompt: buildEstimatePrompt(description, servingNote),
    tierHint: "economy"
  });
  if (!result.ok) return FAILED_OUTCOME;

  let parsed;
  try {
    parsed = parseEstimateResult(result.object);
  } catch {
    return FAILED_OUTCOME;
  }

  if (parsed.outcome === "needs_details") {
    return {
      kind: "needs_details",
      items: [],
      nutrients: null,
      missingDetails: parsed.missingDetails,
      clarificationQuestion: parsed.clarificationQuestion
    };
  }

  const items: MealItem[] = parsed.items.map((item) => ({
    label: item.label,
    portionNote: item.portionNote,
    nutrients: validateNutrients(item.nutrientFields)
  }));

  return {
    kind: "estimated",
    items,
    nutrients: sumItemNutrients(items),
    missingDetails: null,
    clarificationQuestion: null
  };
}
