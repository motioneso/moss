// external-modules/meals/src/plans/meal-job.ts
//
// The meals.meal-job queue handler. swap_choices writes the three choices of one meal, each
// through the same checks a planned meal passes. safety_recheck re-runs Safety on a meal's recipe
// for its current eaters. quick_swap writes one fast replacement straight onto the meal.

import type { MemberView } from "../contracts.js";
import type { RecipeDraft } from "../ai/recipe.js";
import { titleKey } from "../domain/repeats.js";
import { addDays } from "../domain/skeleton.js";
import { mealShareKcal, portionFor } from "../domain/targets.js";
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
  // The same one-star rule the day job applies: a dish anyone eating this meal rated one star is
  // not offered, unless the plan's own request text names it. A swap must never surface it either.
  const vetoes = (await deps.vetoes?.(kitchen.members.map((person) => person.memberId))) ?? [];
  const eaterIds = new Set(meal.eaters.map((eater) => eater.memberId));
  const asked = titleKey(plan.requestText ?? "");
  const vetoed = vetoes.filter(
    (veto) =>
      eaterIds.has(veto.memberId) &&
      !(veto.titleKey !== "" && ` ${asked} `.includes(` ${veto.titleKey} `))
  );
  const vetoedKeys = new Set(vetoed.map((veto) => veto.titleKey));
  const recent = plan.allowRepeats
    ? []
    : await deps.store.recentTitles(plan.kitchenId, addDays(day.date, -NO_REPEAT_DAYS), day.date);
  const current = meal.recipeId ? await deps.store.getRecipes([meal.recipeId]) : [];
  const avoid = [
    ...recent,
    ...current,
    ...vetoed.map((veto) => ({ title: veto.title, titleKey: veto.titleKey }))
  ];
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
      vetoedKeys,
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
  // The recipe this check runs against, kept so the save can refuse if it was replaced meanwhile.
  const recipeId = meal.recipeId;
  const [recipe] = await deps.store.getRecipes([recipeId]);
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
  // A re-check queued before a newer job, or before this meal's recipe was rewritten, must not
  // overwrite the newer verdicts: the save only lands while the generation and recipe still match.
  const saved = await deps.store.saveEaterVerdicts({
    mealId: meal.mealId,
    generation: params.generation,
    recipeId,
    eaters
  });
  return saved ? { status: "done", mode: "safety_recheck" } : { status: "stale" };
}

/**
 * Writes one quick replacement straight onto the meal. The cap is read from the meal, so a
 * job that runs late still honours the ask. The Pantry is read in prefer mode even when the
 * plan ignores it, and the model call uses the interactive tier.
 */
async function quickSwap(deps: PlanDeps, params: MealJobParams): Promise<MealJobOutcome> {
  const meal = await deps.store.getMeal(params.mealId);
  if (meal === null) return { status: "missing" };
  if (meal.quickMaxMinutes === null) throw new Error("meal-job: quick_swap has no time cap");
  if (!(await deps.store.claimQuickSwap(params.mealId, params.generation))) {
    return { status: "stale" };
  }
  const [plan, day, kitchen] = await Promise.all([
    deps.store.getPlan(meal.planId),
    deps.store.getDay(meal.dayId),
    deps.kitchen()
  ]);
  if (plan === null || day === null) return { status: "missing" };

  const members = new Map(kitchen.members.map((person) => [person.memberId, person]));
  const people: (MemberView | undefined)[] = meal.eaters.map((eater) =>
    members.get(eater.memberId)
  );
  const vetoes = (await deps.vetoes?.(kitchen.members.map((person) => person.memberId))) ?? [];
  const eaterIds = new Set(meal.eaters.map((eater) => eater.memberId));
  const asked = titleKey(plan.requestText ?? "");
  const vetoed = vetoes.filter(
    (veto) =>
      eaterIds.has(veto.memberId) &&
      !(veto.titleKey !== "" && ` ${asked} `.includes(` ${veto.titleKey} `))
  );
  const vetoedKeys = new Set(vetoed.map((veto) => veto.titleKey));
  const recent = plan.allowRepeats
    ? []
    : await deps.store.recentTitles(plan.kitchenId, addDays(day.date, -NO_REPEAT_DAYS), day.date);
  const current = meal.recipeId ? await deps.store.getRecipes([meal.recipeId]) : [];
  const avoid = [
    ...recent,
    ...current,
    ...vetoed.map((veto) => ({ title: veto.title, titleKey: veto.titleKey }))
  ];
  const cap =
    day.cookTimeLimitMinutes !== null
      ? Math.min(day.cookTimeLimitMinutes, meal.quickMaxMinutes)
      : meal.quickMaxMinutes;
  const pantry = deps.pantry !== undefined ? await readPantryInput(deps, "prefer") : null;

  const result = await draftSafeRecipe({
    deps,
    plan,
    kitchen,
    slotName: meal.slotName,
    date: day.date,
    people,
    cookTimeLimitMinutes: cap,
    avoidTitles: avoid.map((entry) => entry.title),
    recentKeys: new Set(avoid.map((entry) => entry.titleKey)),
    vetoedKeys,
    pantry,
    tierHint: "interactive"
  });
  if (!result.ok) {
    const eaters = result.verdicts
      ? meal.eaters.map((eater, index) => {
          const verdict = result.verdicts![index]!;
          return {
            ...eater,
            safety: verdict.verdict,
            safetyReason: verdict.verdict === "fail" ? verdict.reason : null
          };
        })
      : undefined;
    await deps.store.failQuickSwap(
      params.mealId,
      params.generation,
      result.reason,
      result.attempts,
      eaters
    );
    return { status: "done", mode: "quick_swap" };
  }
  const { draft, key } = result;
  const kcalPerServing = await estimateKcalPerServing(deps.ai, draft);
  const eaters: MealEaterRow[] = meal.eaters.map((eater, index) => {
    const person = people[index];
    const share = person ? mealShareKcal(person, meal.slotName) : null;
    const portion = portionFor(share, kcalPerServing);
    const verdict = result.verdicts[index]!;
    return {
      memberId: eater.memberId,
      portion,
      estimatedKcal: kcalPerServing === null ? null : Math.round(kcalPerServing * portion),
      safety: verdict.verdict,
      safetyReason: verdict.verdict === "fail" ? verdict.reason : null
    };
  });
  const saved = await deps.store.saveQuickSwap({
    mealId: params.mealId,
    generation: params.generation,
    kitchenId: plan.kitchenId,
    attempts: result.attempts,
    recipe: {
      recipeId: deps.newId(),
      title: draft.title,
      titleKey: key,
      steps: draft.steps,
      cookMinutes: draft.cookMinutes,
      baseServings: draft.baseServings,
      kcalPerServing,
      ingredients: draft.ingredients
    },
    eaters
  });
  if (!saved) return { status: "stale" };
  await deps.onPlanChange?.(meal.planId, "written");
  return { status: "done", mode: "quick_swap" };
}

export async function runMealJob(
  deps: PlanDeps,
  input: Readonly<Record<string, unknown>>
): Promise<MealJobOutcome> {
  const params = readParams(input);
  if (params.mode === "swap_choices") return swapChoices(deps, params);
  if (params.mode === "quick_swap") return quickSwap(deps, params);
  return safetyRecheck(deps, params);
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
