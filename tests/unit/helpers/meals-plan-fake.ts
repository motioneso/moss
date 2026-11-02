// tests/unit/helpers/meals-plan-fake.ts
//
// Meals S2 (#3886): an in-memory PlanStore that keeps the SQL store's compare-and-swap rules, a
// scripted model, and a recording enqueue. The handler tests assert on these records.

import type { AiFailure, MealsAi } from "../../../external-modules/meals/src/ai/port.js";
import type { KitchenView, MemberView } from "../../../external-modules/meals/src/contracts.js";
import type { PlanDeps, PlanJobs } from "../../../external-modules/meals/src/plans/deps.js";
import type {
  DayRow,
  MealRow,
  NewPlan,
  NewSwapChoice,
  PlanRow,
  PlanStore,
  RecipeRow,
  SwapChoiceRow
} from "../../../external-modules/meals/src/store/plan-port.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class FakePlanStore implements PlanStore {
  readonly plans = new Map<string, Mutable<PlanRow> & { idempotencyKey: string }>();
  readonly days = new Map<string, Mutable<DayRow>>();
  readonly meals = new Map<string, Mutable<MealRow>>();
  readonly recipes = new Map<string, RecipeRow & { kitchenId: string }>();
  readonly swapChoices = new Map<string, SwapChoiceRow & { mealId: string }>();
  readonly jobGenerations = new Map<string, number>();
  /** Meal ids in the order they were saved ready, to prove meals are saved one by one. */
  readonly readyLog: string[] = [];
  /** Runs before each claimMeal, so a test can flip state between meals. */
  beforeClaimMeal: ((mealId: string) => void) | null = null;

  async createPlan(input: NewPlan) {
    for (const plan of this.plans.values()) {
      if (plan.idempotencyKey === input.idempotencyKey) {
        return { created: false, planId: plan.planId };
      }
    }
    this.plans.set(input.planId, {
      planId: input.planId,
      kitchenId: input.kitchenId,
      startDate: input.startDate,
      dayCount: input.dayCount,
      pantryMode: input.pantryMode,
      requestText: input.requestText,
      allowRepeats: input.allowRepeats,
      state: "active",
      pausedReason: null,
      idempotencyKey: input.idempotencyKey
    });
    for (const day of input.days) {
      this.days.set(day.dayId, {
        dayId: day.dayId,
        planId: input.planId,
        date: day.date,
        status: "pending",
        failureReason: null,
        cookTimeLimitMinutes: null,
        generation: 0
      });
    }
    for (const meal of input.meals) {
      this.meals.set(meal.mealId, {
        mealId: meal.mealId,
        dayId: meal.dayId,
        slotName: meal.slotName,
        slotPosition: meal.slotPosition,
        kind: "recipe",
        sharing: meal.sharing,
        status: "pending",
        failureReason: null,
        locked: false,
        oneOffFor: null,
        favouriteOf: null,
        servingsOverride: null,
        recipeId: null,
        plainText: null,
        cookedAt: null,
        attempts: 0,
        generation: 0,
        quickMaxMinutes: null,
        eaters: meal.eaterIds.map((memberId) => ({
          memberId,
          portion: 1,
          estimatedKcal: null,
          safety: "pending",
          safetyReason: null
        }))
      });
    }
    return { created: true, planId: input.planId };
  }

  async findPlanByKey(key: string) {
    for (const plan of this.plans.values()) if (plan.idempotencyKey === key) return plan.planId;
    return null;
  }

  async getPlan(planId: string) {
    const plan = this.plans.get(planId);
    return plan ? { ...plan } : null;
  }

  async findPlanByDate(date: string) {
    const days = [...this.days.values()].filter((day) => day.date === date);
    return days.at(-1)?.planId ?? null;
  }

  async findCurrentPlan(date: string) {
    const ranked = [...this.plans.values()].map((plan) => {
      const days = [...this.days.values()]
        .filter((day) => day.planId === plan.planId)
        .map((day) => day.date);
      const covers = days.includes(date);
      const upcoming = !covers && days.length > 0 && days.every((day) => day > date);
      return { plan, covers, upcoming, start: days.slice().sort()[0] ?? "" };
    });
    const pick = (list: typeof ranked) => list.at(-1)?.plan.planId ?? null;
    const covering = ranked.filter((entry) => entry.covers);
    if (covering.length > 0) return pick(covering);
    const upcoming = ranked
      .filter((entry) => entry.upcoming)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (upcoming.length > 0) return upcoming[0]!.plan.planId;
    return pick(ranked);
  }

  async setPlanState(
    planId: string,
    state: PlanRow["state"],
    pausedReason: PlanRow["pausedReason"]
  ) {
    const plan = this.plans.get(planId);
    if (plan) Object.assign(plan, { state, pausedReason });
  }

  async setPlanPantryMode(planId: string, mode: PlanRow["pantryMode"]) {
    const plan = this.plans.get(planId);
    if (plan) plan.pantryMode = mode;
  }

  async deletePlan(planId: string) {
    if (!this.plans.delete(planId)) return false;
    for (const day of [...this.days.values()]) {
      if (day.planId !== planId) continue;
      this.days.delete(day.dayId);
      for (const meal of [...this.meals.values()]) {
        if (meal.dayId === day.dayId) this.meals.delete(meal.mealId);
      }
    }
    return true;
  }

  async listDays(planId: string) {
    return [...this.days.values()]
      .filter((day) => day.planId === planId)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => ({ ...day }));
  }

  async getDay(dayId: string) {
    const day = this.days.get(dayId);
    return day ? { ...day } : null;
  }

  async bumpDay(dayId: string) {
    const day = this.days.get(dayId);
    if (!day) return null;
    day.generation += 1;
    day.status = "pending";
    day.failureReason = null;
    for (const meal of this.meals.values()) {
      if (meal.dayId === dayId && (meal.status === "failed" || meal.status === "writing")) {
        Object.assign(meal, { status: "pending", failureReason: null });
      }
    }
    return day.generation;
  }

  async claimDay(dayId: string, generation: number) {
    const day = this.days.get(dayId);
    if (!day || day.generation !== generation || day.status === "ready") return false;
    const busy = [...this.days.values()].some(
      (other) => other.planId === day.planId && other.dayId !== dayId && other.status === "writing"
    );
    if (busy) return false;
    day.status = "writing";
    return true;
  }

  async finishDay(
    dayId: string,
    generation: number,
    status: DayRow["status"],
    failureReason: DayRow["failureReason"]
  ) {
    const day = this.days.get(dayId);
    if (!day || day.generation !== generation) return false;
    Object.assign(day, { status, failureReason });
    return true;
  }

  private sortedMeals(filter: (meal: MealRow) => boolean) {
    const dateOf = (meal: MealRow) => this.days.get(meal.dayId)?.date ?? "";
    return [...this.meals.values()]
      .filter(filter)
      .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.slotPosition - b.slotPosition)
      .map((meal) => ({ ...meal, eaters: meal.eaters.map((eater) => ({ ...eater })) }));
  }

  async listMeals(planId: string) {
    return this.sortedMeals((meal) => this.days.get(meal.dayId)?.planId === planId);
  }

  async listDayMeals(dayId: string) {
    return this.sortedMeals((meal) => meal.dayId === dayId);
  }

  async getMeal(mealId: string) {
    const meal = this.meals.get(mealId);
    const day = meal ? this.days.get(meal.dayId) : undefined;
    if (!meal || !day) return null;
    return { ...meal, planId: day.planId, date: day.date };
  }

  async claimMeal(mealId: string, dayId: string, generation: number) {
    this.beforeClaimMeal?.(mealId);
    const meal = this.meals.get(mealId);
    const day = this.days.get(dayId);
    if (!meal || !day || meal.dayId !== dayId || day.generation !== generation) return false;
    if (meal.status === "ready" || meal.locked) return false;
    if (this.plans.get(day.planId)?.state !== "active") return false;
    Object.assign(meal, { status: "writing", generation, failureReason: null });
    return true;
  }

  async saveMealReady(input: Parameters<PlanStore["saveMealReady"]>[0]) {
    const meal = this.meals.get(input.mealId);
    if (!meal || meal.generation !== input.generation || meal.status !== "writing") return false;
    this.recipes.set(input.recipe.recipeId, { ...input.recipe, kitchenId: input.kitchenId });
    Object.assign(meal, {
      status: "ready",
      failureReason: null,
      recipeId: input.recipe.recipeId,
      attempts: input.attempts,
      eaters: input.eaters.map((eater) => ({ ...eater }))
    });
    this.readyLog.push(input.mealId);
    return true;
  }

  async failMeal(
    mealId: string,
    generation: number,
    failureReason: NonNullable<MealRow["failureReason"]>,
    attempts: number,
    eaters?: readonly MealRow["eaters"][number][]
  ) {
    const meal = this.meals.get(mealId);
    if (!meal || meal.generation !== generation || meal.status !== "writing") return false;
    Object.assign(meal, { status: "failed", failureReason, attempts });
    if (eaters) meal.eaters = eaters.map((eater) => ({ ...eater }));
    return true;
  }

  async setMealLocked(mealId: string, locked: boolean) {
    const meal = this.meals.get(mealId);
    if (!meal || meal.kind !== "recipe" || meal.cookedAt !== null) return false;
    meal.locked = locked;
    return true;
  }

  async resetMeals(mealIds: readonly string[]) {
    let count = 0;
    for (const mealId of mealIds) {
      const meal = this.meals.get(mealId);
      if (!meal || meal.kind !== "recipe" || meal.locked || meal.cookedAt !== null) continue;
      if (meal.status !== "ready" && meal.status !== "failed") continue;
      Object.assign(meal, { status: "pending", failureReason: null, attempts: 0 });
      for (const [choiceId, choice] of this.swapChoices) {
        if (choice.mealId === mealId) this.swapChoices.delete(choiceId);
      }
      count += 1;
    }
    return count;
  }

  async startMealJob(mealId: string) {
    if (!this.meals.has(mealId)) return null;
    const next = (this.jobGenerations.get(mealId) ?? 0) + 1;
    this.jobGenerations.set(mealId, next);
    return next;
  }

  async replaceSwapChoices(
    mealId: string,
    _kitchenId: string,
    generation: number,
    choices: readonly NewSwapChoice[]
  ) {
    for (const [choiceId, choice] of this.swapChoices) {
      if (choice.mealId === mealId) this.swapChoices.delete(choiceId);
    }
    for (const choice of choices) {
      this.swapChoices.set(choice.choiceId, {
        mealId,
        choiceId: choice.choiceId,
        position: choice.position,
        status: "pending",
        recipeId: null,
        generation
      });
    }
  }

  async listSwapChoices(mealId: string) {
    return [...this.swapChoices.values()]
      .filter((choice) => choice.mealId === mealId)
      .sort((a, b) => a.position - b.position)
      .map(({ mealId: _mealId, ...row }) => row);
  }

  async claimSwapChoice(choiceId: string, generation: number) {
    const choice = this.swapChoices.get(choiceId);
    if (!choice || choice.generation !== generation || choice.status !== "pending") return false;
    Object.assign(choice, { status: "writing" });
    return true;
  }

  async saveChoiceReady(input: Parameters<PlanStore["saveChoiceReady"]>[0]) {
    const choice = this.swapChoices.get(input.choiceId);
    if (!choice || choice.generation !== input.generation || choice.status !== "writing") {
      return false;
    }
    this.recipes.set(input.recipe.recipeId, { ...input.recipe, kitchenId: input.kitchenId });
    Object.assign(choice, { status: "ready", recipeId: input.recipe.recipeId });
    return true;
  }

  async failChoice(choiceId: string, generation: number) {
    const choice = this.swapChoices.get(choiceId);
    if (!choice || choice.generation !== generation) return false;
    if (choice.status !== "pending" && choice.status !== "writing") return false;
    Object.assign(choice, { status: "failed" });
    return true;
  }

  async chooseSwap(input: Parameters<PlanStore["chooseSwap"]>[0]) {
    const choice = this.swapChoices.get(input.choiceId);
    const meal = this.meals.get(input.mealId);
    if (!choice || choice.mealId !== input.mealId || choice.status !== "ready") return false;
    if (!meal || meal.kind !== "recipe" || meal.cookedAt !== null) return false;
    if (meal.status !== "ready" && meal.status !== "failed") return false;
    Object.assign(meal, {
      recipeId: choice.recipeId,
      status: "ready",
      failureReason: null,
      attempts: 0,
      eaters: input.eaters.map((eater) => ({ ...eater }))
    });
    for (const [choiceId, other] of this.swapChoices) {
      if (other.mealId === input.mealId) this.swapChoices.delete(choiceId);
    }
    return true;
  }

  async saveEaterVerdicts(input: {
    mealId: string;
    generation: number;
    recipeId: string;
    eaters: readonly MealRow["eaters"][number][];
  }) {
    const meal = this.meals.get(input.mealId);
    if (!meal) return false;
    if ((this.jobGenerations.get(input.mealId) ?? 0) !== input.generation) return false;
    if (meal.recipeId !== input.recipeId) return false;
    for (const verdict of input.eaters) {
      const row = meal.eaters.find((eater) => eater.memberId === verdict.memberId);
      if (row) Object.assign(row, { safety: verdict.safety, safetyReason: verdict.safetyReason });
    }
    return true;
  }

  async startQuickSwap(mealId: string, maxMinutes: number) {
    const meal = this.meals.get(mealId);
    if (!meal) return null;
    meal.quickMaxMinutes = maxMinutes;
    const next = (this.jobGenerations.get(mealId) ?? 0) + 1;
    this.jobGenerations.set(mealId, next);
    return next;
  }

  async claimQuickSwap(mealId: string, generation: number) {
    const meal = this.meals.get(mealId);
    if (!meal || (this.jobGenerations.get(mealId) ?? 0) !== generation) return false;
    if (meal.kind !== "recipe" || meal.cookedAt !== null) return false;
    if (meal.status !== "ready" && meal.status !== "failed") return false;
    Object.assign(meal, { status: "writing", failureReason: null });
    return true;
  }

  async saveQuickSwap(input: Parameters<PlanStore["saveQuickSwap"]>[0]) {
    const meal = this.meals.get(input.mealId);
    if (!meal || (this.jobGenerations.get(input.mealId) ?? 0) !== input.generation) return false;
    if (meal.status !== "writing") return false;
    this.recipes.set(input.recipe.recipeId, { ...input.recipe, kitchenId: input.kitchenId });
    Object.assign(meal, {
      status: "ready",
      failureReason: null,
      recipeId: input.recipe.recipeId,
      attempts: input.attempts,
      eaters: input.eaters.map((eater) => ({ ...eater }))
    });
    this.readyLog.push(input.mealId);
    return true;
  }

  async failQuickSwap(
    mealId: string,
    generation: number,
    failureReason: NonNullable<MealRow["failureReason"]>,
    attempts: number,
    eaters?: readonly MealRow["eaters"][number][]
  ) {
    const meal = this.meals.get(mealId);
    if (!meal || (this.jobGenerations.get(mealId) ?? 0) !== generation) return false;
    if (meal.status !== "writing") return false;
    Object.assign(meal, { status: "failed", failureReason, attempts });
    if (eaters) meal.eaters = eaters.map((eater) => ({ ...eater }));
    return true;
  }

  async getRecipes(recipeIds: readonly string[]) {
    return recipeIds.flatMap((id) => {
      const recipe = this.recipes.get(id);
      return recipe ? [recipe] : [];
    });
  }

  async recentTitles(kitchenId: string, from: string, to: string) {
    return [...this.meals.values()].flatMap((meal) => {
      const day = this.days.get(meal.dayId);
      const recipe = meal.recipeId ? this.recipes.get(meal.recipeId) : undefined;
      if (!day || !recipe || meal.status !== "ready" || recipe.kitchenId !== kitchenId) return [];
      if (day.date < from || day.date > to) return [];
      return [{ title: recipe.title, titleKey: recipe.titleKey }];
    });
  }
}

// ── Scripted model ─────────────────────────────────────────────────────────

export type AiCallKind = "recipe" | "safety" | "estimate";

export interface AiCall {
  readonly kind: AiCallKind;
  readonly tierHint: string | undefined;
  readonly prompt: string;
}

/** Answers each call kind from its own queue; an empty queue repeats the last answer. */
export class ScriptedAi implements MealsAi {
  readonly calls: AiCall[] = [];
  private readonly queues = new Map<AiCallKind, (unknown | AiFailure)[]>();
  private readonly fallback = new Map<AiCallKind, unknown>();

  script(kind: AiCallKind, ...answers: unknown[]): this {
    this.queues.set(kind, [...(this.queues.get(kind) ?? []), ...answers]);
    return this;
  }

  /** Every later call of this kind gets this answer once its queue is empty. */
  always(kind: AiCallKind, answer: unknown): this {
    this.fallback.set(kind, answer);
    return this;
  }

  count(kind: AiCallKind): number {
    return this.calls.filter((call) => call.kind === kind).length;
  }

  async generateStructured(input: {
    schema: Record<string, unknown>;
    prompt: string;
    tierHint?: "reasoning" | "interactive" | "economy";
  }) {
    const kind = kindOf(input.schema);
    this.calls.push({ kind, tierHint: input.tierHint, prompt: input.prompt });
    const queue = this.queues.get(kind) ?? [];
    const answer = queue.length > 0 ? queue.shift() : this.fallback.get(kind);
    if (answer instanceof AiError) return { ok: false as const, error: answer.kind };
    if (answer === undefined) throw new Error(`no scripted ${kind} answer`);
    return { ok: true as const, object: typeof answer === "function" ? answer() : answer };
  }
}

export class AiError {
  constructor(readonly kind: AiFailure) {}
}

function kindOf(schema: Record<string, unknown>): AiCallKind {
  const properties = Object.keys((schema["properties"] as object | undefined) ?? {});
  if (properties.includes("ingredients")) return "recipe";
  if (properties.includes("eaters")) return "safety";
  return "estimate";
}

// ── Recording enqueue ─────────────────────────────────────────────────────

export interface EnqueueCall {
  readonly queue: string;
  readonly idempotencyKey: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export class RecordingJobs implements PlanJobs {
  readonly calls: EnqueueCall[] = [];
  private readonly seen = new Set<string>();
  nextResult: "duplicate" | "limited_hourly" | "limited_pending" | null = null;

  async enqueue(input: Parameters<PlanJobs["enqueue"]>[0]) {
    this.calls.push({
      queue: input.queue,
      idempotencyKey: input.idempotencyKey,
      params: input.params
    });
    if (this.seen.has(input.idempotencyKey)) return { status: "duplicate" as const };
    const forced = this.nextResult;
    this.nextResult = null;
    if (forced === "duplicate") return { status: "duplicate" as const };
    if (forced === "limited_hourly")
      return { status: "limited" as const, limit: "hourly" as const };
    if (forced === "limited_pending")
      return { status: "limited" as const, limit: "pending" as const };
    this.seen.add(input.idempotencyKey);
    return { status: "enqueued" as const };
  }

  /** Removes and returns the oldest enqueued job's params, to run it as the queue would. */
  take(): Readonly<Record<string, unknown>> | undefined {
    return this.calls.shift()?.params;
  }
}

// ── Kitchen and answers ───────────────────────────────────────────────────

export function member(overrides: Partial<MemberView> & { memberId: string }): MemberView {
  return {
    name: overrides.memberId,
    isSelf: false,
    linkedAccountEmail: null,
    calorieTarget: null,
    macroTargets: { proteinG: null, carbG: null, fatG: null },
    mealPattern: ["dinner"],
    restrictions: [],
    preferences: [],
    favouriteRecipeIds: [],
    ...overrides
  };
}

export function kitchenOf(members: readonly MemberView[]): KitchenView {
  return {
    kitchenId: "11111111-1111-4111-8111-111111111111",
    unitsSystem: "us",
    defaultPantryMode: "prefer",
    members,
    slotRules: []
  };
}

let recipeCounter = 0;

/** A fresh valid recipe answer with a unique title each call, unless one is given. */
export function recipeAnswer(
  overrides: { title?: string; lines?: readonly string[]; cookMinutes?: number } = {}
) {
  return () => {
    recipeCounter += 1;
    const lines = overrides.lines ?? ["1 cup rice", "2 carrots"];
    return {
      title: overrides.title ?? `Dish ${recipeCounter}`,
      cookMinutes: overrides.cookMinutes ?? 30,
      baseServings: 2,
      steps: ["Cook it."],
      ingredients: lines.map((line) => ({
        originalText: line,
        name: line.replace(/^[\d\s]+(cup|tbsp|tsp|g)?\s*/, ""),
        quantity: null,
        unit: null,
        section: "other",
        checkLabel: false
      }))
    };
  };
}

export function safetyPass(eaterCount: number) {
  return {
    eaters: Array.from({ length: eaterCount }, (_, index) => ({
      eater: index + 1,
      verdict: "pass",
      reason: null
    }))
  };
}

export const ESTIMATE_800 = {
  outcome: "estimated",
  items: [
    {
      label: "dish",
      portionNote: null,
      caloriesKcal: 800,
      proteinG: null,
      carbohydratesG: null,
      fatG: null,
      fiberG: null,
      sugarG: null,
      sodiumMg: null
    }
  ],
  missingDetails: null,
  clarificationQuestion: null
};

let idCounter = 0;

export function sequentialIds(): () => string {
  return () => {
    idCounter += 1;
    return `00000000-0000-4000-8000-${idCounter.toString().padStart(12, "0")}`;
  };
}

export function fakeDeps(kitchen: KitchenView, ai = new ScriptedAi()) {
  const store = new FakePlanStore();
  const jobs = new RecordingJobs();
  let writes = 0;
  const deps: PlanDeps = {
    store,
    kitchen: async () => kitchen,
    ensureKitchen: async () => {
      writes += 1;
      return kitchen;
    },
    ai,
    jobs,
    newId: sequentialIds()
  };
  return { deps, store, jobs, ai, kitchenWrites: () => writes };
}
