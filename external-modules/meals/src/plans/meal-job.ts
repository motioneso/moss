// external-modules/meals/src/plans/meal-job.ts
//
// The meals.meal-job queue handler. swap_choices writes the three choices of one meal, each
// through the same checks a planned meal passes. safety_recheck re-runs Safety on a meal's recipe
// for its current eaters. quick_swap is declared and rejected until S9.

import type { MemberView } from "../contracts.js";
import type { RecipeDraft } from "../ai/recipe.js";
import { addDays } from "../domain/skeleton.js";
import { estimateKcalPerServing } from "../estimator/recipe-kcal.js";
import type { MealEaterRow } from "../store/plan-port.js";
import {
  MEAL_JOB_KIND,
  MEAL_JOB_QUEUE,
  mealJobKey,
  type MealJobMode,
  type PlanDeps
} from "./deps.js";
import { checkSafety, draftSafeRecipe } from "./draft.js";
import { readPantryInput } from "./day-job.js";

const NO_REPEAT_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES: readonly MealJobMode[] = ["swap_choices", "quick_swap", "safety_recheck"];

export type MealJobOutcome =
  | { readonly status: "stale" | "missing" }
  | { readonly status: "done"; readonly mode: MealJobMode };

interface MealJobParams {
  readonly mealId: string;
  readonly generation: number;
  readonly mode: MealJobMode;
}

function readParams(input: Readonly<Record<string, unknown>>): MealJobParams {
  const { mealId, generation, mode } = input;
  if (typeof mealId !== "string" || !UUID.test(mealId)) throw new Error("meal-job: bad mealId");
  if (
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 100000
  ) {
    throw new Error("meal-job: bad generation");
  }
  if (typeof mode !== "string" || !MODES.includes(mode as MealJobMode)) {
    throw new Error("meal-job: bad mode");
  }
  return { mealId, generation, mode: mode as MealJobMode };
}

async function swapChoices(deps: PlanDeps, params: MealJobParams): Promise<MealJobOutcome> {
  const meal = await deps.store.getMeal(params.mealId);
  if (meal === null) return { status: "missing" };
  const [plan, day, kitchen, choices] = await Promise.all([
    deps.store.getPlan(meal.planId),
    deps.store.getDay(meal.dayId),
    deps.kitchen(),
    deps.store.listSwapChoices(meal.mealId)
  ]);
  if (plan === null || day === null) return { status: "missing" };
  if (!choices.some((choice) => choice.generation === params.generation)) {
    return { status: "stale" };
  }

  const members = new Map(kitchen.members.map((person) => [person.memberId, person]));
  const people: (MemberView | undefined)[] = meal.eaters.map((eater) =>
    members.get(eater.memberId)
  );
  const recent = plan.allowRepeats
    ? []
    : await deps.store.recentTitles(plan.kitchenId, addDays(day.date, -NO_REPEAT_DAYS), day.date);
  const current = meal.recipeId ? await deps.store.getRecipes([meal.recipeId]) : [];
  const avoid = [...recent, ...current];
  const avoidTitles = avoid.map((entry) => entry.title);
  const recentKeys = new Set(avoid.map((entry) => entry.titleKey));
  const pantry =
    deps.pantry !== undefined && plan.pantryMode !== "ignore"
      ? await readPantryInput(deps, plan.pantryMode)
      : null;

  for (const choice of choices) {
    if (choice.generation !== params.generation) continue;
    if (!(await deps.store.claimSwapChoice(choice.choiceId, params.generation))) continue;
    const result = await draftSafeRecipe({
      deps,
      plan,
      kitchen,
      slotName: meal.slotName,
      date: day.date,
      people,
      cookTimeLimitMinutes: day.cookTimeLimitMinutes,
      avoidTitles,
      recentKeys,
      pantry
    });
    if (!result.ok) {
      await deps.store.failChoice(choice.choiceId, params.generation);
      continue;
    }
    const { draft, key } = result;
    const kcalPerServing = await estimateKcalPerServing(deps.ai, draft);
    const saved = await deps.store.saveChoiceReady({
      choiceId: choice.choiceId,
      generation: params.generation,
      kitchenId: plan.kitchenId,
      recipe: {
        recipeId: deps.newId(),
        title: draft.title,
        titleKey: key,
        steps: draft.steps,
        cookMinutes: draft.cookMinutes,
        baseServings: draft.baseServings,
        kcalPerServing,
        ingredients: draft.ingredients
      }
    });
    if (!saved) return { status: "stale" };
    // The next choice must differ from this one.
    avoidTitles.push(draft.title);
    recentKeys.add(key);
  }
  return { status: "done", mode: "swap_choices" };
}

/** Re-runs Safety on the meal's recipe for its current eaters and stores each verdict. */
async function safetyRecheck(deps: PlanDeps, params: MealJobParams): Promise<MealJobOutcome> {
  const meal = await deps.store.getMeal(params.mealId);
  if (meal === null || meal.recipeId === null) return { status: "missing" };
  const [recipe] = await deps.store.getRecipes([meal.recipeId]);
  if (recipe === undefined) return { status: "missing" };
  const kitchen = await deps.kitchen();
  const members = new Map(kitchen.members.map((person) => [person.memberId, person]));
  const restrictions = meal.eaters.map((eater) => members.get(eater.memberId)?.restrictions ?? []);
  const draft: RecipeDraft = {
    title: recipe.title,
    steps: recipe.steps,
    cookMinutes: recipe.cookMinutes,
    baseServings: recipe.baseServings,
    ingredients: recipe.ingredients
  };
  const checked = await checkSafety(deps, draft, restrictions);
  if (checked.kind === "error")
    throw new Error(`meal-job: safety check failed (${checked.reason})`);
  const eaters: MealEaterRow[] = meal.eaters.map((eater, index) => {
    const verdict = checked.verdicts[index]!;
    return {
      ...eater,
      safety: verdict.verdict,
      safetyReason: verdict.verdict === "fail" ? verdict.reason : null
    };
  });
  await deps.store.saveEaterVerdicts(meal.mealId, eaters);
  return { status: "done", mode: "safety_recheck" };
}

export async function runMealJob(
  deps: PlanDeps,
  input: Readonly<Record<string, unknown>>
): Promise<MealJobOutcome> {
  const params = readParams(input);
  if (params.mode === "quick_swap") throw new Error("meal-job: quick_swap is not available yet");
  return params.mode === "swap_choices" ? swapChoices(deps, params) : safetyRecheck(deps, params);
}

/** Queues a Safety re-run for one meal, for callers that change who eats it. */
export async function enqueueSafetyRecheck(deps: PlanDeps, mealId: string): Promise<void> {
  const generation = await deps.store.startMealJob(mealId);
  if (generation === null) return;
  await deps.jobs.enqueue({
    queue: MEAL_JOB_QUEUE,
    jobKind: MEAL_JOB_KIND,
    idempotencyKey: mealJobKey(mealId, "safety_recheck", generation),
    params: { mealId, generation, mode: "safety_recheck" }
  });
}
