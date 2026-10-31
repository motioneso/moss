// external-modules/meals/src/plans/deps.ts
//
// What the plan tools and the day job need from the worker context, as narrow ports so the
// handler tests can run against an in-memory store, a scripted model and a recording enqueue.

import type { ModuleJobEnqueueResult } from "@moss/module-sdk/worker";

import type { MealsAi } from "../ai/port.js";
import type { KitchenView } from "../contracts.js";
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
  /** The kitchen, created with a self member on first use. */
  readonly kitchen: () => Promise<KitchenView>;
  readonly ai: MealsAi;
  readonly jobs: PlanJobs;
  readonly newId: () => string;
}

export const PLAN_DAY_QUEUE = "meals.plan-day";
export const PLAN_DAY_JOB_KIND = "plan_day";

export function planDayKey(dayId: string, generation: number): string {
  return `plan-day:${dayId}:g${generation}`;
}
