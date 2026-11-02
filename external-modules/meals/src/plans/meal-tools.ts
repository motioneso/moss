// external-modules/meals/src/plans/meal-tools.ts
//
// The meals.meal.edit and meals.meal.swap tool handlers. Locking keeps a meal through
// Regenerate. A swap asks for three choices, written by a job, and Choose puts one on the meal.

import type { RecipeView } from "../contracts.js";
import { mealShareKcal, portionFor } from "../domain/targets.js";
import type { MealRow } from "../store/plan-port.js";
import { MEAL_JOB_KIND, MEAL_JOB_QUEUE, mealJobKey, type PlanDeps } from "./deps.js";
import { enqueueSafetyRecheck } from "./meal-job.js";
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

function optionalSlotName(input: Input): string | null {
  const value = input["targetSlotName"];
  if (value === undefined || value === null) return null;
  return requireString(input, "targetSlotName", 40);
}

async function moveMeal(deps: PlanDeps, meal: MealRow & { planId: string }, input: Input) {
  if (meal.cookedAt !== null) throw new PlanInputError("A cooked meal cannot be moved");
  if (meal.status === "writing") {
    throw new PlanInputError("Wait for this meal to finish writing before moving it");
  }
  const days = await deps.store.listDays(meal.planId);
  const targetDayId = input["targetDayId"];
  const targetDate = input["targetDate"];
  const target =
    typeof targetDayId === "string"
      ? days.find((day) => day.dayId === targetDayId)
      : typeof targetDate === "string"
        ? days.find((day) => day.date === targetDate)
        : undefined;
  if (target === undefined) {
    throw new PlanInputError(
      typeof targetDayId === "string" || typeof targetDate === "string"
        ? "That day is in another plan"
        : "Give targetDayId or targetDate"
    );
  }
  const slotName = optionalSlotName(input) ?? meal.slotName;
  const targetMeals = await deps.store.listDayMeals(target.dayId);
  const slotPosition =
    targetMeals.find((entry) => entry.slotName === slotName)?.slotPosition ??
    targetMeals.reduce((max, entry) => Math.max(max, entry.slotPosition), -1) + 1;
  if (
    !(await deps.store.moveMeal({
      mealId: meal.mealId,
      dayId: target.dayId,
      slotName,
      slotPosition
    }))
  ) {
    throw new PlanInputError("A cooked meal cannot be moved");
  }
  await deps.onPlanChange?.(meal.planId, "written");
}

async function setEaters(deps: PlanDeps, meal: MealRow & { planId: string }, input: Input) {
  if (meal.kind !== "recipe" || meal.recipeId === null) {
    throw new PlanInputError("Only a recipe meal has eaters to change");
  }
  if (meal.cookedAt !== null) throw new PlanInputError("A cooked meal's eaters cannot change");
  if (meal.status !== "ready" && meal.status !== "failed") {
    throw new PlanInputError("Wait for this meal to finish writing before changing its eaters");
  }
  const raw = input["eaterIds"];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 40 ||
    raw.some((id) => typeof id !== "string")
  ) {
    throw new PlanInputError("eaterIds must name at least one person");
  }
  const kitchen = await deps.kitchen();
  const members = membersById(kitchen);
  const eaterIds = [...new Set(raw as string[])];
  for (const id of eaterIds) {
    if (!members.has(id)) throw new PlanInputError("That person is not in the household");
  }
  const [recipe] = await deps.store.getRecipes([meal.recipeId]);
  if (recipe === undefined) throw new PlanInputError("That meal has no recipe yet");
  const eaters = eaterIds.map((memberId) => {
    const person = members.get(memberId)!;
    const portion = portionFor(mealShareKcal(person, meal.slotName), recipe.kcalPerServing);
    return {
      memberId,
      portion,
      estimatedKcal:
        recipe.kcalPerServing === null ? null : Math.round(recipe.kcalPerServing * portion),
      safety: "pending" as const,
      safetyReason: null
    };
  });
  if (!(await deps.store.setMealEaters({ mealId: meal.mealId, eaters }))) {
    throw new PlanInputError("That meal's eaters cannot change");
  }
  // The new eaters have no Safety verdicts yet. The re-check job runs Safety for them.
  await enqueueSafetyRecheck(deps, meal.mealId);
  await deps.onPlanChange?.(meal.planId, "written");
}

export async function mealEdit(deps: PlanDeps, input: Input): Promise<RecipeView> {
  const mealId = requireString(input, "mealId", 64);
  const action = input["action"];
  if (action !== "lock" && action !== "unlock" && action !== "move" && action !== "set_eaters") {
    throw new PlanInputError("action must be lock, unlock, move or set_eaters");
  }
  const meal = await requireMeal(deps, mealId);
  if (action === "move") {
    await moveMeal(deps, meal, input);
    return loadRecipe(deps, mealId);
  }
  if (action === "set_eaters") {
    await setEaters(deps, meal, input);
    return loadRecipe(deps, mealId);
  }
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

export async function mealSwap(deps: PlanDeps, input: Input): Promise<RecipeView> {
  const mealId = requireString(input, "mealId", 64);
  const action = input["action"];
  if (action === "request_choices") {
    await requestChoices(deps, mealId);
  } else if (action === "choose") {
    await choose(deps, mealId, requireString(input, "choiceId", 64));
  } else {
    throw new PlanInputError("action must be request_choices or choose");
  }
  return loadRecipe(deps, mealId);
}
