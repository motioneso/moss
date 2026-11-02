// external-modules/meals/src/log/deps.ts
//
// What the log tools and the estimate job need from the worker context, as narrow ports so the
// handler tests can run against an in-memory store, a scripted model and a recording enqueue.
import type { MealsAi } from "../ai/port.js";
import type { KitchenView } from "../contracts.js";
import type { PlanJobs } from "../plans/deps.js";
import type { LogStore } from "../store/log-port.js";

export interface LogDeps {
  readonly store: LogStore;
  /** The kitchen, read without writing. Targets come from its self member. */
  readonly kitchen: () => Promise<KitchenView>;
  readonly jobs: PlanJobs;
  readonly newId: () => string;
  readonly now: () => Date;
  /** The user's own time zone from the host, when set. */
  readonly localTimezone: string | undefined;
}

export interface LogJobDeps {
  readonly store: LogStore;
  readonly ai: MealsAi;
}

export const LOG_ESTIMATE_QUEUE = "meals.log-estimate";
export const LOG_ESTIMATE_JOB_KIND = "log_estimate";

export function logEstimateKey(entryId: string, revision: number): string {
  return `log-estimate:${entryId}:r${revision}`;
}
