// external-modules/meals/src/store/plan-port.ts
//
// The plan store contract. The module database has no transactions, so every write that must
// not race is a compare-and-swap on a generation, and multi-row writes are single statements.
// store/plans.ts implements it in SQL; the handler tests implement it in memory.

import type {
  GenerationFailure,
  PantryMode,
  Sharing,
  StoreSection,
  WriteStatus
} from "../contracts.js";

export type PlanState = "active" | "stopped" | "paused";
export type EnqueueLimit = "invocation" | "pending" | "hourly";

export interface PlanRow {
  readonly planId: string;
  readonly kitchenId: string;
  readonly startDate: string;
  readonly dayCount: number;
  readonly pantryMode: PantryMode;
  readonly requestText: string | null;
  readonly allowRepeats: boolean;
  readonly state: PlanState;
  readonly pausedReason: EnqueueLimit | null;
}

export interface DayRow {
  readonly dayId: string;
  readonly planId: string;
  readonly date: string;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly cookTimeLimitMinutes: number | null;
  readonly generation: number;
}

export interface MealEaterRow {
  readonly memberId: string;
  readonly portion: number;
  readonly estimatedKcal: number | null;
  readonly safety: "pending" | "pass" | "fail";
  readonly safetyReason: string | null;
}

export interface MealRow {
  readonly mealId: string;
  readonly dayId: string;
  readonly slotName: string;
  readonly slotPosition: number;
  readonly kind: "recipe" | "text";
  readonly sharing: Sharing;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly locked: boolean;
  readonly oneOffFor: string | null;
  readonly favouriteOf: string | null;
  readonly servingsOverride: number | null;
  readonly recipeId: string | null;
  readonly plainText: string | null;
  readonly cookedAt: string | null;
  readonly attempts: number;
  readonly generation: number;
  readonly quickMaxMinutes: number | null;
  readonly eaters: readonly MealEaterRow[];
}

export interface IngredientRow {
  readonly originalText: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly section: StoreSection;
  readonly checkLabel: boolean;
}

export interface RecipeRow {
  readonly recipeId: string;
  readonly title: string;
  readonly titleKey: string;
  readonly steps: readonly string[];
  readonly cookMinutes: number;
  readonly baseServings: number;
  readonly kcalPerServing: number | null;
  readonly ingredients: readonly IngredientRow[];
}

export interface NewPlan {
  readonly planId: string;
  readonly kitchenId: string;
  readonly startDate: string;
  readonly dayCount: number;
  readonly pantryMode: PantryMode;
  readonly requestText: string | null;
  readonly allowRepeats: boolean;
  readonly idempotencyKey: string;
  readonly days: readonly { readonly dayId: string; readonly date: string }[];
  readonly meals: readonly {
    readonly mealId: string;
    readonly dayId: string;
    readonly slotName: string;
    readonly slotPosition: number;
    readonly sharing: Sharing;
    readonly eaterIds: readonly string[];
  }[];
}

export interface ReadyMeal {
  readonly mealId: string;
  readonly generation: number;
  readonly attempts: number;
  readonly recipe: Omit<RecipeRow, "recipeId"> & { readonly recipeId: string };
  readonly kitchenId: string;
  readonly eaters: readonly MealEaterRow[];
}

export interface SwapChoiceRow {
  readonly choiceId: string;
  readonly position: number;
  readonly status: WriteStatus;
  readonly recipeId: string | null;
  readonly generation: number;
}

export interface NewSwapChoice {
  readonly choiceId: string;
  readonly position: number;
}

export interface RecentTitle {
  readonly title: string;
  readonly titleKey: string;
}

export interface PlanStore {
  /** Inserts the plan with its days (generation 0), meals and eaters in one statement. */
  createPlan(input: NewPlan): Promise<{ readonly created: boolean; readonly planId: string }>;
  /** The plan an idempotency key already created, if any. */
  findPlanByKey(idempotencyKey: string): Promise<string | null>;
  getPlan(planId: string): Promise<PlanRow | null>;
  /** The newest plan whose days include the date. */
  findPlanByDate(date: string): Promise<string | null>;
  /**
   * The plan the Plan tab shows on a date: one that covers it, else the next one to start, else
   * the newest. Null when no plan exists.
   */
  findCurrentPlan(date: string): Promise<string | null>;
  setPlanState(planId: string, state: PlanState, pausedReason: EnqueueLimit | null): Promise<void>;
  /** Changes the plan's Pantry mode. A re-plan uses it to force prefer on hand. */
  setPlanPantryMode(planId: string, mode: PantryMode): Promise<void>;
  deletePlan(planId: string): Promise<boolean>;

  /** Every day of the plan in date order. */
  listDays(planId: string): Promise<readonly DayRow[]>;
  getDay(dayId: string): Promise<DayRow | null>;
  /**
   * Raises the day's generation, sets it pending and resets its failed meals to pending.
   * Ready meals are never touched. Returns the new generation, or null for a missing day.
   */
  bumpDay(dayId: string): Promise<number | null>;
  /**
   * Sets a pending or failed day to writing when the generation matches and no other day in the
   * plan is writing, so a plan writes one day at a time.
   */
  claimDay(dayId: string, generation: number): Promise<boolean>;
  /** Sets the day's final status when the generation still matches. */
  finishDay(
    dayId: string,
    generation: number,
    status: WriteStatus,
    failureReason: GenerationFailure | null
  ): Promise<boolean>;

  /** Every meal of the plan, by date then slot position. */
  listMeals(planId: string): Promise<readonly MealRow[]>;
  /** Every meal of one day, by slot position. */
  listDayMeals(dayId: string): Promise<readonly MealRow[]>;
  getMeal(
    mealId: string
  ): Promise<(MealRow & { readonly planId: string; readonly date: string }) | null>;
  /**
   * Sets a not-ready, unlocked meal to writing when the day's generation matches and the plan
   * is active. This is the Stop check before each meal.
   */
  claimMeal(mealId: string, dayId: string, generation: number): Promise<boolean>;
  /** Saves the recipe, its ingredients, the eaters and the ready meal in one statement. */
  saveMealReady(input: ReadyMeal): Promise<boolean>;
  /** Marks a writing meal failed; eaters, when given, carry the last Safety verdicts. */
  failMeal(
    mealId: string,
    generation: number,
    failureReason: GenerationFailure,
    attempts: number,
    eaters?: readonly MealEaterRow[]
  ): Promise<boolean>;

  /** Locks or unlocks a recipe meal that has not been cooked. False when the meal does not qualify. */
  setMealLocked(mealId: string, locked: boolean): Promise<boolean>;
  /**
   * Sets the replaceable meals among `mealIds` (see domain/regenerate) back to pending and
   * deletes their swap choices. Returns how many meals it reset. Their recipes stay stored.
   */
  resetMeals(mealIds: readonly string[]): Promise<number>;

  /** Raises the meal's job counter and returns the new value, or null for a missing meal. */
  startMealJob(mealId: string): Promise<number | null>;
  /** Deletes the meal's swap choices and stores the new ones as pending, in one statement. */
  replaceSwapChoices(
    mealId: string,
    kitchenId: string,
    generation: number,
    choices: readonly NewSwapChoice[]
  ): Promise<void>;
  listSwapChoices(mealId: string): Promise<readonly SwapChoiceRow[]>;
  /** Sets a pending choice to writing when its generation matches. */
  claimSwapChoice(choiceId: string, generation: number): Promise<boolean>;
  /** Stores the choice's recipe and marks it ready, when the generation matches. */
  saveChoiceReady(input: {
    readonly choiceId: string;
    readonly generation: number;
    readonly kitchenId: string;
    readonly recipe: ReadyMeal["recipe"];
  }): Promise<boolean>;
  failChoice(choiceId: string, generation: number): Promise<boolean>;
  /**
   * Puts a ready choice's recipe on its meal, marks the meal ready with the given eater rows, and
   * deletes every choice for the meal. False when the choice is not ready or the meal is no longer
   * a ready or failed, uncooked recipe meal.
   */
  chooseSwap(input: {
    readonly mealId: string;
    readonly choiceId: string;
    readonly eaters: readonly MealEaterRow[];
  }): Promise<boolean>;
  /**
   * Overwrites each listed eater's Safety verdict, but only while the meal's job generation and
   * recipe still match the ones the check ran against. False means the job went stale and wrote
   * nothing, so an old queued re-check cannot overwrite newer verdicts.
   */
  saveEaterVerdicts(input: {
    readonly mealId: string;
    readonly generation: number;
    readonly recipeId: string;
    readonly eaters: readonly MealEaterRow[];
  }): Promise<boolean>;

  /**
   * Stores the quick swap cap on the meal and raises its job counter. Returns the new
   * generation, or null for a missing meal.
   */
  startQuickSwap(mealId: string, maxMinutes: number): Promise<number | null>;
  /** Sets a ready or failed recipe meal to writing when its job generation still matches. */
  claimQuickSwap(mealId: string, generation: number): Promise<boolean>;
  /**
   * Saves the quick swap recipe onto its meal when the job generation still matches and the
   * meal is writing. False means a newer job owns the meal and this one writes nothing.
   */
  saveQuickSwap(input: {
    readonly mealId: string;
    readonly generation: number;
    readonly kitchenId: string;
    readonly recipe: ReadyMeal["recipe"];
    readonly eaters: readonly MealEaterRow[];
    readonly attempts: number;
  }): Promise<boolean>;
  /** Marks a writing quick swap meal failed, when its job generation still matches. */
  failQuickSwap(
    mealId: string,
    generation: number,
    failureReason: GenerationFailure,
    attempts: number,
    eaters?: readonly MealEaterRow[]
  ): Promise<boolean>;

  getRecipes(recipeIds: readonly string[]): Promise<readonly RecipeRow[]>;
  /** Titles of ready meals in the kitchen on days from `from` to `to`, inclusive. */
  recentTitles(kitchenId: string, from: string, to: string): Promise<readonly RecentTitle[]>;
}
