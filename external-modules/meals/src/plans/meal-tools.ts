// external-modules/meals/src/plans/meal-tools.ts
//
// The meals.meal.edit and meals.meal.swap tool handlers. Locking keeps a meal through
// Regenerate. A swap asks for three choices, written by a job, and Choose puts one on the meal.

import type { RecipeView } from "../contracts.js";
import type { MealRow } from "../store/plan-port.js";
import { MEAL_JOB_KIND, MEAL_JOB_QUEUE, mealJobKey, type PlanDeps } from "./deps.js";
import { loadRecipe, PlanInputError, requireString } from "./tools.js";
import { eatersForRecipe, membersById } from "./view.js";

type Input = Readonly<Record<string, unknown>>;

export const SWAP_CHOICE_COUNT = 3;

async function requireMeal(deps: PlanDeps, mealId: string) {
  const meal = await deps.store.getMeal(mealId);
  if (meal === null) throw new PlanInputError("No meal with that id");
  return meal;
}

function requireSwappable(meal: MealRow): void {
  if (meal.kind !== "recipe") throw new PlanInputError("Only a recipe meal can be swapped");
  if (meal.cookedAt !== null) throw new PlanInputError("A cooked meal cannot be swapped");
  if (meal.status !== "ready" && meal.status !== "failed") {
    throw new PlanInputError("Wait for this meal to finish writing before swapping it");
  }
}

export async function mealEdit(deps: PlanDeps, input: Input): Promise<RecipeView> {
  const mealId = requireString(input, "mealId", 64);
  const action = input["action"];
  if (action !== "lock" && action !== "unlock") {
    throw new PlanInputError("action must be lock or unlock");
  }
  const meal = await requireMeal(deps, mealId);
  if (action === "lock" && (meal.kind !== "recipe" || meal.status !== "ready")) {
    throw new PlanInputError("Only a written recipe meal can be locked");
  }
  if (!(await deps.store.setMealLocked(mealId, action === "lock"))) {
    throw new PlanInputError("A cooked or text meal cannot be locked");
  }
  return loadRecipe(deps, mealId);
}

async function requestChoices(deps: PlanDeps, mealId: string): Promise<void> {
  const meal = await requireMeal(deps, mealId);
  requireSwappable(meal);
  const plan = await deps.store.getPlan(meal.planId);
  if (plan === null) throw new PlanInputError("No plan with that id");
  const generation = await deps.store.startMealJob(mealId);
  if (generation === null) throw new PlanInputError("No meal with that id");
  const choices = Array.from({ length: SWAP_CHOICE_COUNT }, (_, index) => ({
    choiceId: deps.newId(),
    position: index + 1
  }));
  await deps.store.replaceSwapChoices(mealId, plan.kitchenId, generation, choices);
  const result = await deps.jobs.enqueue({
    queue: MEAL_JOB_QUEUE,
    jobKind: MEAL_JOB_KIND,
    idempotencyKey: mealJobKey(mealId, "swap_choices", generation),
    params: { mealId, generation, mode: "swap_choices" }
  });
  if (result.status === "limited") {
    for (const choice of choices) await deps.store.failChoice(choice.choiceId, generation);
    throw new PlanInputError(`Swapping is paused by the ${result.limit} limit. Try again later.`);
  }
}

async function choose(deps: PlanDeps, mealId: string, choiceId: string): Promise<void> {
  const meal = await requireMeal(deps, mealId);
  requireSwappable(meal);
  const choice = (await deps.store.listSwapChoices(mealId)).find(
    (candidate) => candidate.choiceId === choiceId
  );
  if (choice === undefined || choice.status !== "ready" || choice.recipeId === null) {
    throw new PlanInputError("That choice is not ready");
  }
  const [recipe] = await deps.store.getRecipes([choice.recipeId]);
  if (recipe === undefined) throw new PlanInputError("That choice is not ready");
  const eaters = eatersForRecipe(meal, recipe, membersById(await deps.kitchen()));
  if (!(await deps.store.chooseSwap({ mealId, choiceId, eaters }))) {
    throw new PlanInputError("That choice can no longer be used");
  }
  // The meal's recipe changed, so the shopping list rebuilds now; ticks carry over by line.
  await deps.onPlanChange?.(meal.planId, "written");
}

async function quick(deps: PlanDeps, mealId: string, input: Input): Promise<void> {
  const maxMinutes = input["maxMinutes"];
  if (
    typeof maxMinutes !== "number" ||
    !Number.isInteger(maxMinutes) ||
    maxMinutes < 5 ||
    maxMinutes > 240
  ) {
    throw new PlanInputError("maxMinutes must be a whole number from 5 to 240");
  }
  const meal = await requireMeal(deps, mealId);
  requireSwappable(meal);
  const generation = await deps.store.startQuickSwap(mealId, maxMinutes);
  if (generation === null) throw new PlanInputError("No meal with that id");
  const result = await deps.jobs.enqueue({
    queue: MEAL_JOB_QUEUE,
    jobKind: MEAL_JOB_KIND,
    idempotencyKey: mealJobKey(mealId, "quick_swap", generation),
    params: { mealId, generation, mode: "quick_swap" }
  });
  if (result.status === "limited") {
    throw new PlanInputError(
      `Quick swapping is paused by the ${result.limit} limit. Try again later.`
    );
  }
}

export async function mealSwap(deps: PlanDeps, input: Input): Promise<RecipeView> {
  const mealId = requireString(input, "mealId", 64);
  const action = input["action"];
  if (action === "request_choices") {
    await requestChoices(deps, mealId);
  } else if (action === "choose") {
    await choose(deps, mealId, requireString(input, "choiceId", 64));
  } else if (action === "quick") {
    await quick(deps, mealId, input);
  } else {
    throw new PlanInputError("action must be request_choices, choose or quick");
  }
  return loadRecipe(deps, mealId);
}
