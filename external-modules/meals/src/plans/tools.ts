// external-modules/meals/src/plans/tools.ts
//
// The meals.plan.* and meals.meal.get tool handlers. Creating a plan writes its skeleton and
// enqueues the first day; the day job chains the rest.

import type { PantryMode, PlanView, RecipeView } from "../contracts.js";
import { MAX_PLAN_DAYS, parseIsoDate, planSkeleton } from "../domain/skeleton.js";
import type { DayRow, NewPlan, PlanRow } from "../store/plan-port.js";
import { PLAN_DAY_JOB_KIND, PLAN_DAY_QUEUE, planDayKey, type PlanDeps } from "./deps.js";
import { planView, recipeView } from "./view.js";

type Input = Readonly<Record<string, unknown>>;

const PANTRY_MODES: readonly PantryMode[] = ["ignore", "prefer", "only"];
const MAX_REQUEST_TEXT = 1000;

export class PlanInputError extends Error {}

function requireString(input: Input, field: string, max: number): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new PlanInputError(`${field} must be 1 to ${max} characters`);
  }
  return value.trim();
}

function optionalString(input: Input, field: string): string | null {
  const value = input[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PlanInputError(`${field} must be text`);
  return value;
}

function requireDate(input: Input, field: string): string {
  const value = requireString(input, field, 10);
  try {
    parseIsoDate(value);
  } catch {
    throw new PlanInputError(`${field} must be a date like 2026-11-02`);
  }
  return value;
}

function parseMealTypes(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((name) => typeof name !== "string" || name.trim() === "" || name.length > 40)
  ) {
    throw new PlanInputError("mealTypes must list 1 to 8 meal names such as dinner");
  }
  return value as string[];
}

async function loadView(deps: PlanDeps, plan: PlanRow): Promise<PlanView> {
  const [days, meals, kitchen] = await Promise.all([
    deps.store.listDays(plan.planId),
    deps.store.listMeals(plan.planId),
    deps.kitchen()
  ]);
  const recipeIds = meals.flatMap((meal) => (meal.recipeId ? [meal.recipeId] : []));
  const recipes = recipeIds.length > 0 ? await deps.store.getRecipes(recipeIds) : [];
  return planView(plan, days, meals, recipes, kitchen);
}

async function requirePlan(deps: PlanDeps, planId: string): Promise<PlanRow> {
  const plan = await deps.store.getPlan(planId);
  if (plan === null) throw new PlanInputError("No plan with that id");
  return plan;
}

/**
 * Raises the day's generation and enqueues its job under a fresh key, so a key the platform
 * still remembers can never block a rerun. A limit pauses the plan with the limit's name.
 */
export async function enqueueDay(deps: PlanDeps, planId: string, dayId: string): Promise<void> {
  const generation = await deps.store.bumpDay(dayId);
  if (generation === null) return;
  const result = await deps.jobs.enqueue({
    queue: PLAN_DAY_QUEUE,
    jobKind: PLAN_DAY_JOB_KIND,
    idempotencyKey: planDayKey(dayId, generation),
    params: { planId, dayId, generation }
  });
  if (result.status === "limited") await deps.store.setPlanState(planId, "paused", result.limit);
}

export async function planCreate(deps: PlanDeps, input: Input): Promise<PlanView> {
  const startDate = requireDate(input, "startDate");
  const dayCount = input["days"];
  if (typeof dayCount !== "number" || !Number.isInteger(dayCount)) {
    throw new PlanInputError("days must be a whole number");
  }
  if (dayCount < 1 || dayCount > MAX_PLAN_DAYS) {
    throw new PlanInputError(`days must be 1 to ${MAX_PLAN_DAYS}`);
  }
  const idempotencyKey = requireString(input, "idempotencyKey", 128);
  const pantryInput = input["pantryMode"];
  if (pantryInput !== undefined && !PANTRY_MODES.includes(pantryInput as PantryMode)) {
    throw new PlanInputError("pantryMode must be ignore, prefer or only");
  }
  const requestRaw = optionalString(input, "requestText")?.trim() ?? "";
  if (requestRaw.length > MAX_REQUEST_TEXT) {
    throw new PlanInputError(`requestText must be at most ${MAX_REQUEST_TEXT} characters`);
  }
  const mealTypes = parseMealTypes(input["mealTypes"]);
  const allowRepeats = input["allowRepeats"] ?? false;
  if (typeof allowRepeats !== "boolean")
    throw new PlanInputError("allowRepeats must be true or false");

  const existing = await deps.store.findPlanByKey(idempotencyKey);
  if (existing !== null) return loadView(deps, await requirePlan(deps, existing));

  const kitchen = await deps.ensureKitchen();
  const skeleton = planSkeleton(kitchen, { startDate, days: dayCount, mealTypes });
  if (skeleton.every((day) => day.meals.length === 0)) {
    throw new PlanInputError("No one in the household eats the meals asked for");
  }
  const days = skeleton.map((day) => ({ dayId: deps.newId(), date: day.date }));
  const meals = skeleton.flatMap((day, index) =>
    day.meals.map((meal) => ({
      mealId: deps.newId(),
      dayId: days[index]!.dayId,
      slotName: meal.slotName,
      slotPosition: meal.slotPosition,
      sharing: meal.sharing,
      eaterIds: meal.eaterIds
    }))
  );
  const newPlan: NewPlan = {
    planId: deps.newId(),
    kitchenId: kitchen.kitchenId,
    startDate,
    dayCount,
    pantryMode: (pantryInput as PantryMode | undefined) ?? kitchen.defaultPantryMode,
    requestText: requestRaw === "" ? null : requestRaw,
    allowRepeats,
    idempotencyKey,
    days,
    meals
  };
  const { created, planId } = await deps.store.createPlan(newPlan);
  if (created && days[0] !== undefined) await enqueueDay(deps, planId, days[0].dayId);
  return loadView(deps, await requirePlan(deps, planId));
}

export async function planGet(deps: PlanDeps, input: Input): Promise<PlanView> {
  let planId = optionalString(input, "planId");
  if (planId === null) {
    if (input["date"] === undefined) throw new PlanInputError("Give a planId or a date");
    planId = await deps.store.findPlanByDate(requireDate(input, "date"));
    if (planId === null) throw new PlanInputError("No plan covers that date");
  }
  return loadView(deps, await requirePlan(deps, planId));
}

/** The plan the Plan tab shows. `plan` is null when nothing has been planned yet. */
export async function planCurrent(
  deps: PlanDeps,
  input: Input
): Promise<{ readonly plan: PlanView | null }> {
  const date = requireDate(input, "date");
  const planId = await deps.store.findCurrentPlan(date);
  if (planId === null) return { plan: null };
  return { plan: await loadView(deps, await requirePlan(deps, planId)) };
}

function findDay(days: readonly DayRow[], input: Input): DayRow {
  const dayId = optionalString(input, "dayId");
  const date = dayId === null ? requireDate(input, "date") : null;
  const day = days.find((candidate) =>
    dayId !== null ? candidate.dayId === dayId : candidate.date === date
  );
  if (day === undefined) throw new PlanInputError("That day is not in this plan");
  return day;
}

export async function planControl(deps: PlanDeps, input: Input): Promise<PlanView> {
  const plan = await requirePlan(deps, requireString(input, "planId", 64));
  const action = input["action"];

  if (action === "stop") {
    await deps.store.setPlanState(plan.planId, "stopped", null);
  } else if (action === "resume") {
    await deps.store.setPlanState(plan.planId, "active", null);
    const days = await deps.store.listDays(plan.planId);
    const next = days.find((day) => day.status === "pending" || day.status === "writing");
    if (next !== undefined) await enqueueDay(deps, plan.planId, next.dayId);
  } else if (action === "retry_day") {
    const day = findDay(await deps.store.listDays(plan.planId), input);
    if (day.status === "ready") throw new PlanInputError("That day is already written");
    await deps.store.setPlanState(plan.planId, "active", null);
    await enqueueDay(deps, plan.planId, day.dayId);
  } else {
    throw new PlanInputError("action must be stop, resume or retry_day");
  }
  return loadView(deps, await requirePlan(deps, plan.planId));
}

export async function planDelete(
  deps: PlanDeps,
  input: Input
): Promise<{ readonly deleted: true }> {
  const planId = requireString(input, "planId", 64);
  if ((await deps.store.getPlan(planId)) !== null) await deps.onPlanChange?.(planId, "deleted");
  const deleted = await deps.store.deletePlan(planId);
  if (!deleted) throw new PlanInputError("No plan with that id");
  return { deleted: true };
}

export async function mealGet(deps: PlanDeps, input: Input): Promise<RecipeView> {
  const meal = await deps.store.getMeal(requireString(input, "mealId", 64));
  if (meal === null) throw new PlanInputError("No meal with that id");
  const [recipes, kitchen] = await Promise.all([
    meal.recipeId ? deps.store.getRecipes([meal.recipeId]) : Promise.resolve([]),
    deps.kitchen()
  ]);
  return recipeView(meal, recipes[0], kitchen);
}
