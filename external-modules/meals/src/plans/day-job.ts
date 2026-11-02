// external-modules/meals/src/plans/day-job.ts
//
// The meals.plan-day queue handler. One job writes one day, saving each meal as it finishes,
// then enqueues the next pending day while the plan is active (spec correction C1).

import type { AiFailure } from "../ai/port.js";
import type { GenerationFailure, KitchenView, MemberView } from "../contracts.js";
import type { PantryInput } from "../domain/pantry.js";
import { titleKey } from "../domain/repeats.js";
import type { SafetyVerdict } from "../domain/safety.js";
import { addDays } from "../domain/skeleton.js";
import { mealShareKcal, portionFor } from "../domain/targets.js";
import { estimateKcalPerServing } from "../estimator/recipe-kcal.js";
import type { Veto } from "../store/cooking-port.js";
import type { DayRow, MealEaterRow, MealRow, PlanRow } from "../store/plan-port.js";
import type { PlanDeps } from "./deps.js";
import { draftSafeRecipe } from "./draft.js";
import { enqueueDay } from "./tools.js";

const NO_REPEAT_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DayJobOutcome =
  | { readonly status: "stale" | "stopped" | "missing" }
  | { readonly status: "written"; readonly day: "ready" | "failed" };

interface DayParams {
  readonly planId: string;
  readonly dayId: string;
  readonly generation: number;
}

function readParams(input: Readonly<Record<string, unknown>>): DayParams {
  const { planId, dayId, generation } = input;
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("plan-day: bad planId");
  if (typeof dayId !== "string" || !UUID.test(dayId)) throw new Error("plan-day: bad dayId");
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("plan-day: bad generation");
  }
  return { planId, dayId, generation };
}

type MealOutcome =
  | { readonly kind: "ready"; readonly title: string; readonly titleKey: string }
  | { readonly kind: "ai_error"; readonly error: AiFailure }
  | { readonly kind: "safety_cap" }
  | { readonly kind: "lost" };

interface DayContext {
  readonly deps: PlanDeps;
  readonly plan: PlanRow;
  readonly day: DayRow;
  readonly generation: number;
  readonly kitchen: KitchenView;
  readonly avoidTitles: string[];
  readonly recentKeys: Set<string>;
  /** One-star recipes for people in this plan. A request that names the recipe overrides them. */
  readonly vetoes: readonly Veto[];
  /** Null when the plan ignores the Pantry or there is no Pantry store. */
  readonly pantry: PantryInput | null;
}

function verdictRow(eater: MealEaterRow, verdict: SafetyVerdict): MealEaterRow {
  return {
    ...eater,
    safety: verdict.verdict,
    safetyReason: verdict.verdict === "fail" ? verdict.reason : null
  };
}

async function writeMeal(context: DayContext, meal: MealRow): Promise<MealOutcome> {
  const { deps, plan, day, generation, kitchen } = context;
  const members = new Map(kitchen.members.map((person) => [person.memberId, person]));
  const people: (MemberView | undefined)[] = meal.eaters.map((eater) =>
    members.get(eater.memberId)
  );

  // A one-star recipe is avoided for the people who eat this meal, unless the plan's own request
  // text names that dish (S10 vetoes, kept through S7's shared drafting path).
  const eaterIds = new Set(meal.eaters.map((eater) => eater.memberId));
  const asked = titleKey(plan.requestText ?? "");
  const vetoed = context.vetoes.filter(
    (veto) =>
      eaterIds.has(veto.memberId) &&
      !(veto.titleKey !== "" && ` ${asked} `.includes(` ${veto.titleKey} `))
  );
  const vetoedKeys = new Set(vetoed.map((veto) => veto.titleKey));
  const avoidTitles = [...context.avoidTitles, ...vetoed.map((veto) => veto.title)];

  const result = await draftSafeRecipe({
    deps,
    plan,
    kitchen,
    slotName: meal.slotName,
    date: day.date,
    people,
    cookTimeLimitMinutes: day.cookTimeLimitMinutes,
    avoidTitles,
    recentKeys: context.recentKeys,
    vetoedKeys,
    pantry: context.pantry
  });
  if (!result.ok) {
    const verdicts = result.verdicts;
    const eaters = verdicts
      ? meal.eaters.map((eater, index) => verdictRow(eater, verdicts[index]!))
      : undefined;
    await deps.store.failMeal(meal.mealId, generation, result.reason, result.attempts, eaters);
    return result.reason === "safety_cap"
      ? { kind: "safety_cap" }
      : { kind: "ai_error", error: result.reason as AiFailure };
  }

  const { draft, key } = result;
  const kcalPerServing = await estimateKcalPerServing(deps.ai, draft);
  const eaters = meal.eaters.map((eater, index) => {
    const person = people[index];
    const share = person ? mealShareKcal(person, meal.slotName) : null;
    const portion = portionFor(share, kcalPerServing);
    return {
      ...verdictRow(eater, result.verdicts[index]!),
      portion,
      estimatedKcal: kcalPerServing === null ? null : Math.round(kcalPerServing * portion)
    };
  });
  const saved = await deps.store.saveMealReady({
    mealId: meal.mealId,
    generation,
    attempts: result.attempts,
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
    },
    eaters
  });
  return saved ? { kind: "ready", title: draft.title, titleKey: key } : { kind: "lost" };
}

/** Writes every unfinished meal. Returns the day's failure, or the reason it stopped early. */
async function writeDay(
  context: DayContext
): Promise<
  | { readonly kind: "done"; readonly failure: GenerationFailure | null }
  | { readonly kind: "stale" }
  | { readonly kind: "stopped" }
> {
  const { deps, plan, day, generation } = context;
  let failure: GenerationFailure | null = null;
  for (const meal of await deps.store.listDayMeals(day.dayId)) {
    if (meal.status === "ready" || meal.locked) continue;
    if (!(await deps.store.claimMeal(meal.mealId, day.dayId, generation))) {
      const current = await deps.store.getPlan(plan.planId);
      return { kind: current?.state === "active" ? "stale" : "stopped" };
    }
    const outcome = await writeMeal(context, meal);
    if (outcome.kind === "lost") return { kind: "stale" };
    if (outcome.kind === "ready") {
      context.recentKeys.add(outcome.titleKey);
      context.avoidTitles.push(outcome.title);
    } else if (outcome.kind === "ai_error") {
      // The provider is failing; the rest of the day waits for a retry.
      return { kind: "done", failure: outcome.error };
    } else {
      failure ??= "safety_cap";
    }
  }
  return { kind: "done", failure };
}

export async function readPantryInput(
  deps: PlanDeps,
  mode: PantryInput["mode"]
): Promise<PantryInput> {
  const [items, staples] = await Promise.all([
    deps.pantry!.readItems(),
    deps.pantry!.readStaples()
  ]);
  return {
    mode,
    stock: items.map((item) => ({ name: item.name, quantity: item.quantity, unit: item.unit })),
    staples: staples.map((staple) => staple.name)
  };
}

export async function runPlanDay(
  deps: PlanDeps,
  input: Readonly<Record<string, unknown>>
): Promise<DayJobOutcome> {
  const { planId, dayId, generation } = readParams(input);
  const [plan, day] = await Promise.all([deps.store.getPlan(planId), deps.store.getDay(dayId)]);
  if (plan === null || day === null || day.planId !== planId) return { status: "missing" };
  if (day.generation !== generation) return { status: "stale" };
  if (plan.state !== "active") return { status: "stopped" };

  let result: "ready" | "failed" = "ready";
  if (day.status !== "ready") {
    if (!(await deps.store.claimDay(dayId, generation))) return { status: "stale" };
    const kitchen = await deps.kitchen();
    const recent = plan.allowRepeats
      ? []
      : await deps.store.recentTitles(plan.kitchenId, addDays(day.date, -NO_REPEAT_DAYS), day.date);
    const vetoes = (await deps.vetoes?.(kitchen.members.map((person) => person.memberId))) ?? [];
    // A regenerated meal keeps its old recipe until the new one is saved. Writing the same dish
    // again would make Regenerate look like it did nothing.
    const replacedIds = (await deps.store.listDayMeals(dayId)).flatMap((meal) =>
      meal.recipeId !== null && meal.status !== "ready" ? [meal.recipeId] : []
    );
    const replaced = replacedIds.length > 0 ? await deps.store.getRecipes(replacedIds) : [];
    const avoid = [...recent, ...replaced];
    const pantry =
      deps.pantry !== undefined && plan.pantryMode !== "ignore"
        ? await readPantryInput(deps, plan.pantryMode)
        : null;
    const outcome = await writeDay({
      pantry,
      deps,
      plan,
      day,
      generation,
      kitchen,
      avoidTitles: avoid.map((entry) => entry.title),
      recentKeys: new Set(avoid.map((entry) => entry.titleKey)),
      vetoes
    });
    if (outcome.kind === "stale") return { status: "stale" };
    if (outcome.kind === "stopped") {
      await deps.store.finishDay(dayId, generation, "pending", null);
      return { status: "stopped" };
    }
    result = outcome.failure === null ? "ready" : "failed";
    await deps.store.finishDay(dayId, generation, result, outcome.failure);
    await deps.onPlanChange?.(planId, "written");
  }

  const current = await deps.store.getPlan(planId);
  if (current?.state !== "active") return { status: "written", day: result };
  const days = await deps.store.listDays(planId);
  const next = days.find((candidate) => candidate.status === "pending");
  if (next !== undefined) await enqueueDay(deps, planId, next.dayId);
  return { status: "written", day: result };
}
