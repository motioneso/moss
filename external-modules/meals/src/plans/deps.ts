// external-modules/meals/src/plans/deps.ts
//
// What the plan tools and the day job need from the worker context, as narrow ports so the
// handler tests can run against an in-memory store, a scripted model and a recording enqueue.

import type { ModuleJobEnqueueResult } from "@moss/module-sdk/worker";

import type { MealsAi } from "../ai/port.js";
import type { KitchenView } from "../contracts.js";
import type { Marks, Veto } from "../store/cooking-port.js";
import type { PantryStore } from "../store/pantry-port.js";
import type { PlanStore } from "../store/plan-port.js";

export interface PlanJobs {
  enqueue(input: {
    readonly queue: string;
    readonly jobKind: string;
    readonly idempotencyKey: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<ModuleJobEnqueueResult>;
}

export interface PlanDeps {
  readonly store: PlanStore;
  /** The kitchen, read without writing. Read tools may only run SELECT. */
  readonly kitchen: () => Promise<KitchenView>;

  /** The kitchen, with its row and self member stored. Only plan.create calls it. */
  readonly ensureKitchen: () => Promise<KitchenView>;
  /** The Pantry and Staples, read when a plan's mode is prefer or only. */
  readonly pantry?: PantryStore;
  /** Ratings and favourites shown on each eater. Absent in tests that ignore them. */
  readonly marks?: () => Promise<Marks>;
  /** One-star ratings by these people. Their recipes stay out of new plans unless asked for. */
  readonly vetoes?: (memberIds: readonly string[]) => Promise<readonly Veto[]>;
  readonly ai: MealsAi;
  readonly jobs: PlanJobs;
  readonly newId: () => string;
  /** The worker clock. Tests set it, live code uses the real clock. */
  readonly now?: () => Date;
  /** The user's own time zone from the worker context, when the host provides one. */
  readonly localTimezone?: string;
  /**
   * Called after a plan's meals change (a day finished writing) and just before a plan is
   * deleted, so a shopping list tied to the plan can rebuild. Absent in tests that ignore lists.
   */
  readonly onPlanChange?: (planId: string, change: "written" | "deleted") => Promise<void>;
}

export const PLAN_DAY_QUEUE = "meals.plan-day";
export const PLAN_DAY_JOB_KIND = "plan_day";

export function planDayKey(dayId: string, generation: number): string {
  return `plan-day:${dayId}:g${generation}`;
}

export const MEAL_JOB_QUEUE = "meals.meal-job";
export const MEAL_JOB_KIND = "meal_job";
export type MealJobMode = "swap_choices" | "quick_swap" | "safety_recheck";

export function mealJobKey(mealId: string, mode: MealJobMode, generation: number): string {
  return `meal-job:${mealId}:${mode}:g${generation}`;
}
