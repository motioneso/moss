// external-modules/meals/src/plans/day-job.ts
//
// The meals.plan-day queue handler. One job writes one day, saving each meal as it finishes,
// then enqueues the next pending day while the plan is active (spec correction C1).

import type { AiFailure } from "../ai/port.js";
import { buildRecipePrompt, parseRecipe, RECIPE_SCHEMA, type RecipeDraft } from "../ai/recipe.js";
import { buildSafetyPrompt, parseSafety, SAFETY_SCHEMA } from "../ai/safety.js";
import type { GenerationFailure, KitchenView, MemberView } from "../contracts.js";
import { offPantry, type PantryInput } from "../domain/pantry.js";
import { isRepeat, titleKey } from "../domain/repeats.js";
import {
  applyBrandRule,
  deterministicSafety,
  mergeSafety,
  type SafetyVerdict
} from "../domain/safety.js";
import { addDays } from "../domain/skeleton.js";
import { mealShareKcal, portionFor } from "../domain/targets.js";
import { estimateKcalPerServing } from "../estimator/recipe-kcal.js";
import type { Veto } from "../store/cooking-port.js";
import type { DayRow, MealEaterRow, MealRow, PlanRow } from "../store/plan-port.js";
import type { PlanDeps } from "./deps.js";
import { enqueueDay } from "./tools.js";

/** The first attempt plus two regenerations. */
const MAX_ATTEMPTS = 3;
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

function pantryText(item: PantryInput["stock"][number]): string {
  if (item.quantity === null) return item.name;
  return `${item.name} (${item.quantity}${item.unit ? ` ${item.unit}` : ""})`;
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
  const restrictionsOf = (index: number) => people[index]?.restrictions ?? [];

  const eaterIds = new Set(meal.eaters.map((eater) => eater.memberId));
  const asked = titleKey(plan.requestText ?? "");
  const vetoed = context.vetoes.filter(
    (veto) =>
      eaterIds.has(veto.memberId) &&
      !(veto.titleKey !== "" && ` ${asked} `.includes(` ${veto.titleKey} `))
  );
  const vetoedKeys = new Set(vetoed.map((veto) => veto.titleKey));
  const avoidTitles = [...context.avoidTitles, ...vetoed.map((veto) => veto.title)];

  let attempts = 0;
  let lastVerdicts: readonly SafetyVerdict[] | null = null;
  let lastRejection: "safety" | "pantry" | "veto" = "safety";
  const fail = async (reason: GenerationFailure): Promise<MealOutcome> => {
    const eaters = lastVerdicts
      ? meal.eaters.map((eater, index) => verdictRow(eater, lastVerdicts![index]!))
      : undefined;
    await deps.store.failMeal(meal.mealId, generation, reason, attempts, eaters);
    return reason === "safety_cap"
      ? { kind: "safety_cap" }
      : { kind: "ai_error", error: reason as AiFailure };
  };

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const written = await deps.ai.generateStructured({
      schema: RECIPE_SCHEMA,
      prompt: buildRecipePrompt({
        slotName: meal.slotName,
        date: day.date,
        eaters: people.map((person) => ({
          shareKcal: person ? mealShareKcal(person, meal.slotName) : null,
          restrictions: person?.restrictions ?? [],
          preferences: person?.preferences ?? []
        })),
        cookTimeLimitMinutes: day.cookTimeLimitMinutes,
        requestText: plan.requestText,
        avoidTitles,
        unitsSystem: kitchen.unitsSystem,
        ...(context.pantry !== null && context.pantry.mode !== "ignore"
          ? {
              pantry: {
                mode: context.pantry.mode,
                items: context.pantry.stock.map(pantryText),
                staples: context.pantry.staples
              }
            }
          : {})
      }),
      tierHint: "reasoning"
    });
    if (!written.ok) return fail(written.error);
    let draft: RecipeDraft;
    try {
      draft = parseRecipe(written.object, { cookTimeLimitMinutes: day.cookTimeLimitMinutes });
    } catch {
      return fail("validation_failed");
    }
    draft = { ...draft, ingredients: applyBrandRule(draft.ingredients) };

    const key = titleKey(draft.title);
    if (!plan.allowRepeats && isRepeat(key, context.recentKeys)) continue;
    if (vetoedKeys.has(key)) {
      lastRejection = "veto";
      continue;
    }

    // Cook only from on hand: a recipe that needs anything else is rejected and rewritten.
    if (
      context.pantry?.mode === "only" &&
      offPantry(draft.ingredients, context.pantry).length > 0
    ) {
      lastRejection = "pantry";
      continue;
    }

    const ruleVerdicts = meal.eaters.map((_, index) =>
      deterministicSafety(draft.ingredients, restrictionsOf(index))
    );
    if (ruleVerdicts.some((verdict) => verdict.verdict === "fail")) {
      lastVerdicts = ruleVerdicts;
      lastRejection = "safety";
      continue;
    }

    const judged = await deps.ai.generateStructured({
      schema: SAFETY_SCHEMA,
      prompt: buildSafetyPrompt(
        draft,
        meal.eaters.map((_, index) => ({ restrictions: restrictionsOf(index) }))
      ),
      tierHint: "reasoning"
    });
    if (!judged.ok) return fail(judged.error);
    let modelVerdicts;
    try {
      modelVerdicts = parseSafety(judged.object, meal.eaters.length);
    } catch {
      return fail("validation_failed");
    }
    const merged = ruleVerdicts.map((verdict, index) =>
      mergeSafety(verdict, modelVerdicts[index] ?? null)
    );
    if (merged.some((verdict) => verdict.verdict === "fail")) {
      lastVerdicts = merged;
      lastRejection = "safety";
      continue;
    }

    const kcalPerServing = await estimateKcalPerServing(deps.ai, draft);
    const eaters = meal.eaters.map((eater, index) => {
      const person = people[index];
      const share = person ? mealShareKcal(person, meal.slotName) : null;
      const portion = portionFor(share, kcalPerServing);
      return {
        ...verdictRow(eater, merged[index]!),
        portion,
        estimatedKcal: kcalPerServing === null ? null : Math.round(kcalPerServing * portion)
      };
    });
    const saved = await deps.store.saveMealReady({
      mealId: meal.mealId,
      generation,
      attempts,
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
  // Running out of tries on the Pantry or one-star rules is not a Never serve problem.
  return fail(lastRejection !== "safety" ? "validation_failed" : "safety_cap");
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

async function readPantryInput(deps: PlanDeps, mode: PantryInput["mode"]): Promise<PantryInput> {
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
      avoidTitles: recent.map((entry) => entry.title),
      recentKeys: new Set(recent.map((entry) => entry.titleKey)),
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
