// external-modules/meals/src/estimator/recipe-kcal.ts
//
// Calories per serving of a written recipe, through the copied estimator. Null when the estimate
// fails or is out of range, so calorie fit shows as unknown rather than wrong.

import type { MealsAi } from "../ai/port.js";
import type { RecipeDraft } from "../ai/recipe.js";
import { estimateFromDescription } from "./run.js";

const MAX_KCAL_PER_SERVING = 5000;

export async function estimateKcalPerServing(
  ai: MealsAi,
  recipe: RecipeDraft
): Promise<number | null> {
  const description = `${recipe.title}. Ingredients: ${recipe.ingredients
    .map((line) => line.originalText)
    .join("; ")}`;
  const outcome = await estimateFromDescription(
    ai,
    description,
    `The whole recipe, which makes ${recipe.baseServings} servings`
  );
  const total = outcome.nutrients?.caloriesKcal ?? null;
  if (outcome.kind !== "estimated" || total === null) return null;
  const perServing = Math.round(total / recipe.baseServings);
  return perServing >= 0 && perServing <= MAX_KCAL_PER_SERVING ? perServing : null;
}
