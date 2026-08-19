// external-modules/food/src/worker/handlers/estimate.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 5): the "estimate.run" queue handler body — the retry
// path for Fork A's synchronous-first estimation (plan §2 Fork A). Moved here byte-identical
// (logic unchanged, only relative import depth) from the former src/worker.ts per team-lead's
// worker-registry ruling (#926): assistant tools and queue jobs are dispatched through ONE
// defineModuleWorker registry (../registry.ts), matching finance's
// external-modules/finance/src/worker/registry.ts:28 precedent — so this file now exports only
// the handler function, and defineModuleWorker itself lives in ../index.ts.
//
// Constraint 3 / R12 (modules have no transactions): the meal write already
// happened (createMeal, store/sql.ts) before this job is ever queued —
// Fork A persists the meal first and estimates second, so a crash anywhere
// in this handler degrades to "meal exists, estimate_state stays whatever
// it already was", never a lost or half-written meal. This handler's own
// write (recordEstimate) is itself a CAS UPDATE + INSERT with no
// transaction wrapping either; see store/sql.ts's recordEstimate doc
// comment for why that is safe (plan §4 Task 7 test 13).
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { estimateFromDescription } from "../../estimator/run.js";
import { sqlStore } from "../../store/sql.js";

/** food.settings (manifest storage[0].namespace), user scope, key "consent". */
const CONSENT_NAMESPACE = "food.settings";
const CONSENT_KEY = "consent";

interface EstimateRunParams {
  readonly mealId: string;
  readonly revision: number;
}

/**
 * Reads the queue job's params off ctx.input. The manifest's paramsSchema
 * (jarvis.module.json worker.queues[0].paramsSchema) already constrains
 * these host-side before this handler runs; this is a defensive second
 * check, not the primary guard — a malformed input here throws, which
 * defineModuleWorker turns into a generic handler_failed (no content, see
 * packages/module-sdk/src/worker.ts's catch block) rather than proceeding
 * on a guess.
 */
function readParams(input: Record<string, unknown>): EstimateRunParams {
  const mealId = input["mealId"];
  const revision = input["revision"];
  if (typeof mealId !== "string" || mealId.length === 0) {
    throw new Error("estimate.run: mealId must be a non-empty string");
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new Error("estimate.run: revision must be a positive integer");
  }
  return { mealId, revision };
}

async function hasGrantedConsent(ctx: ModuleWorkerContext): Promise<boolean> {
  const record = await ctx.kv.get("user", CONSENT_NAMESPACE, CONSENT_KEY);
  return record !== null && record["granted"] === true;
}

/**
 * The estimate.run handler. Every branch that does nothing (meal gone,
 * stale revision, consent not granted) returns a status string rather than
 * throwing — none of these are failures, they are the ordinary outcomes the
 * stale-revision guard (constraint 5) and consent gate (constraint 4) exist
 * to produce.
 */
export async function runEstimate(
  ctx: ModuleWorkerContext
): Promise<{ readonly status: "no-op" | "recorded"; readonly reason?: string }> {
  const { mealId, revision } = readParams(ctx.input);
  const store = sqlStore(ctx.db);

  const meal = await store.getMeal(mealId);
  if (meal === null) {
    return { status: "no-op", reason: "meal_not_found" };
  }
  // Stale-revision guard (constraint 5): a correction landed after this job
  // was queued. Re-estimating against the description this job was queued
  // for would silently overwrite whatever the user changed it to.
  if (meal.estimateRevision !== revision) {
    return { status: "no-op", reason: "stale_revision" };
  }

  // Consent gate (constraint 4), checked BEFORE any provider call. The
  // meal's estimate_state is left exactly as it was (createMeal sets
  // 'pending') — this handler makes no write at all when consent is
  // ungranted, which is what "no provider call" has to mean structurally:
  // recordEstimate is what WOULD move estimate_state off 'pending', so
  // simply not calling it is the whole guard.
  if (!(await hasGrantedConsent(ctx))) {
    return { status: "no-op", reason: "consent_not_granted" };
  }

  // servingNote is now persisted on Meal (store/sql.ts's CreateMealInput/Meal, team-lead ruling
  // #926) so a retry through this queue handler has the same serving note the user typed at
  // create time — no longer lost between the create-tool's call and a later retry.
  const outcome = await estimateFromDescription(ctx.ai, meal.description, meal.servingNote);

  const recorded = await store.recordEstimate(mealId, revision, {
    state: outcome.kind,
    items: outcome.items,
    nutrients: outcome.nutrients,
    missingDetails: outcome.missingDetails,
    clarificationQuestion: outcome.clarificationQuestion
  });
  if (recorded === null) {
    // Lost the CAS race between the read above and recordEstimate's own
    // UPDATE (another writer moved the revision in between) — the same
    // "nothing to do" outcome as the stale-revision guard above.
    return { status: "no-op", reason: "stale_revision" };
  }
  return { status: "recorded" };
}
