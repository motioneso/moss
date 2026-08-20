// external-modules/food/src/tools/meals.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 4): food.meals.list, .summarize,
// .log, .correct, .delete. Built on FoodStore (../store/sql.js, Task 3 —
// read-only from here) and the domain functions in ../domain/*.js (also
// read-only from here). Every handler is a factory `create*Handler(store)`
// returning `(ctx: ModuleWorkerContext) => Promise<...>`, matching
// job-search's src/worker/handlers/matches.ts pattern (finance's
// ports-closure ToolFactory does not fit here — see
// external-modules/job-search/src/worker/registry.ts's header comment: the
// store has to be built fresh per call from ctx.db, which only exists
// inside a per-RPC invocation, not at module load).
//
// Fork A (plan §2): food.meals.log estimates SYNCHRONOUSLY via
// estimateFromDescription (Task 5, ../estimator/run.js) when AI estimation is
// granted — this file imports that function but does not edit
// src/estimator/* or src/worker.ts (both out of this task's scope; see
// worker.ts's own "estimate.run" queue handler for the retry path this
// mirrors). No module handler can enqueue a job itself (worker-rpc-host.ts
// dispatches only attachments/notify/fetch/embed/db/ai/auth/kv) — Fork A is
// how Phase 1 gets a real estimate onto a newly-logged meal at all.

import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import type { CaptureKind, Meal, Nutrients } from "../domain/meal.js";
import { resolveMealLocalDate } from "../domain/meal.js";
import { computeDailyTotals } from "../domain/totals.js";
import { resolveDailyTargets, type DailyTargets } from "../domain/targets.js";
import type { DailyTotals } from "../domain/meal.js";
import { estimateFromDescription } from "../estimator/run.js";
import type { CorrectMealItemPatch, CorrectMealPatch, FoodStore } from "../store/sql.js";
import {
  InputError,
  readEnum,
  readInt,
  readNutrientValue,
  readString,
  requireNoUnknownKeys,
  stripEnvelope
} from "./validate.js";

/**
 * #1750 — the manifest preference key gating AI estimation. Declared with `default: true` in
 * jarvis.module.json, so an absent stored value means "never touched", not "off": installing
 * Food is consent for Food's normal functionality, and estimating is the functionality.
 */
const AI_ESTIMATES_PREFERENCE = "aiEstimates";

const CAPTURE_KINDS: readonly CaptureKind[] = ["text", "photo", "voice"];

/** food.meals.list / .summarize date-range bounds — unbounded ranges risk both an unbounded read
 * (constraint on read tools generally) and blowing the ~16 000-char assistant-tool render cap
 * (job-search's matches.ts precedent) once each day's meals are rendered as rows. Chosen, not
 * measured; revisit if the Phase 1 kill gate surfaces a real need past these. */
const LIST_MAX_RANGE_DAYS = 31;
const SUMMARIZE_MAX_RANGE_DAYS = 92;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireLocalDateString(input: Record<string, unknown>, key: string): string {
  const value = readString(input, key, { required: true });
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new InputError(`${key} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  return value;
}

function optionalLocalDateString(input: Record<string, unknown>, key: string): string | undefined {
  const value = readString(input, key);
  if (value === undefined) return undefined;
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new InputError(`${key} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  return value;
}

/** Inclusive day count between two YYYY-MM-DD strings, computed at UTC midnight — the two values
 * are calendar-date keys already (not instants), so UTC-vs-local does not matter here the way it
 * does for domain/meal.ts's resolveMealLocalDate. */
function inclusiveDaySpan(fromLocalDate: string, toLocalDate: string): number {
  const from = Date.parse(`${fromLocalDate}T00:00:00Z`);
  const to = Date.parse(`${toLocalDate}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

function requireDateRange(
  input: Record<string, unknown>,
  maxRangeDays: number
): { fromLocalDate: string; toLocalDate: string } {
  const fromLocalDate = requireLocalDateString(input, "fromLocalDate");
  const toLocalDate = requireLocalDateString(input, "toLocalDate");
  const span = inclusiveDaySpan(fromLocalDate, toLocalDate);
  if (span < 1) {
    throw new InputError("toLocalDate must not be before fromLocalDate");
  }
  if (span > maxRangeDays) {
    throw new InputError(`date range must not exceed ${maxRangeDays} days`);
  }
  return { fromLocalDate, toLocalDate };
}

// ── food.meals.list ─────────────────────────────────────────────────────

const MEALS_LIST_KEYS = new Set(["localDate", "fromLocalDate", "toLocalDate"]);

export interface MealsListResult {
  readonly meals: readonly Meal[];
  /** Present only for the single-`localDate` shape — a multi-day range has no single day to total. */
  readonly totals: DailyTotals | null;
  /**
   * #1750 — whether AI estimation is switched on for this user. Carried on the read result
   * because a module web surface has no way to read a host preference directly, and without it
   * the Food page would show meals with permanently missing numbers and no explanation for why.
   */
  readonly aiEstimates: boolean;
  /**
   * #1737 item 4 — the user's daily targets, carried for the same reason `aiEstimates` is: a
   * module web surface cannot read a host preference directly. Every field is null when the user
   * has set no target, and the day view then shows no progress rather than a zeroed one.
   */
  readonly targets: DailyTargets;
}

/** `food.meals.list` — read. Exactly one shape: `{localDate}` or `{fromLocalDate, toLocalDate}`.
 * No ambient "today" default (job-search's no-ambient-dates convention, check:no-ambient-dates) —
 * an omitted date shape throws rather than guessing which day the caller meant. */
export function createMealsListHandler(store: FoodStore) {
  return async (ctx: ModuleWorkerContext): Promise<MealsListResult> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, MEALS_LIST_KEYS);

    const localDate = optionalLocalDateString(input, "localDate");
    const fromLocalDate = optionalLocalDateString(input, "fromLocalDate");
    const toLocalDate = optionalLocalDateString(input, "toLocalDate");
    const aiEstimates = aiEstimatesEnabled(ctx);
    const targets = resolveDailyTargets(ctx);

    if (localDate !== undefined) {
      if (fromLocalDate !== undefined || toLocalDate !== undefined) {
        throw new InputError("localDate cannot be combined with fromLocalDate/toLocalDate");
      }
      const meals = await store.listMealsForLocalDate(localDate);
      return { meals, totals: computeDailyTotals(localDate, meals), aiEstimates, targets };
    }

    if (fromLocalDate === undefined || toLocalDate === undefined) {
      throw new InputError("either localDate or both fromLocalDate and toLocalDate are required");
    }
    const span = inclusiveDaySpan(fromLocalDate, toLocalDate);
    if (span < 1) {
      throw new InputError("toLocalDate must not be before fromLocalDate");
    }
    if (span > LIST_MAX_RANGE_DAYS) {
      throw new InputError(`date range must not exceed ${LIST_MAX_RANGE_DAYS} days`);
    }
    const meals = await store.listMealsForDateRange(fromLocalDate, toLocalDate);
    return { meals, totals: null, aiEstimates, targets };
  };
}

// ── food.meals.summarize ────────────────────────────────────────────────

export interface MealsSummarizeResult {
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
  readonly nutrients: Nutrients;
  readonly incomplete: boolean;
  readonly mealsWithoutEstimate: number;
  readonly daysWithMeals: number;
}

/** `food.meals.summarize` — read. Aggregates the whole `[fromLocalDate, toLocalDate]` range as one
 * bucket (stories 26-28) by reusing computeDailyTotals against every meal in range and discarding
 * its single-day `localDate` field, which does not apply to a range. */
export function createMealsSummarizeHandler(store: FoodStore) {
  return async (ctx: ModuleWorkerContext): Promise<MealsSummarizeResult> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, new Set(["fromLocalDate", "toLocalDate"]));
    const { fromLocalDate, toLocalDate } = requireDateRange(input, SUMMARIZE_MAX_RANGE_DAYS);

    const meals = await store.listMealsForDateRange(fromLocalDate, toLocalDate);
    const totals = computeDailyTotals(fromLocalDate, meals);
    const daysWithMeals = new Set(meals.map((meal) => meal.localDate)).size;

    return {
      fromLocalDate,
      toLocalDate,
      nutrients: totals.nutrients,
      incomplete: totals.incomplete,
      mealsWithoutEstimate: totals.mealsWithoutEstimate,
      daysWithMeals
    };
  };
}

// ── food.meals.log ──────────────────────────────────────────────────────

const MEALS_LOG_KEYS = new Set([
  "description",
  "consumedAt",
  "timeZone",
  "captureKind",
  "servingNote",
  "idempotencyKey"
]);

const DESCRIPTION_MAX_BYTES = 2000;
const SERVING_NOTE_MAX_BYTES = 500;
// Matched to the check constraints on app.food_estimate_items, so an over-long
// correction is rejected with a readable message instead of a constraint error.
const ITEM_LABEL_MAX_BYTES = 200;
const ITEM_PORTION_MAX_BYTES = 100;

export interface LogMealResult {
  readonly meal: Meal;
  readonly clarificationQuestion: string | null;
}

/**
 * The host resolves declared preferences against `app.preferences` before every module
 * invocation and puts the result on `ctx.preferences`, falling back to the manifest default for
 * anything the user has not set. Reading it strictly (`=== false`) rather than truthily means a
 * missing key estimates, matching that default — a resolver bug must not silently disable the
 * feature for everyone.
 */
function aiEstimatesEnabled(ctx: ModuleWorkerContext): boolean {
  return ctx.preferences[AI_ESTIMATES_PREFERENCE] !== false;
}

/** `food.meals.log` — write. Persists the meal first (always), then — Fork A — estimates
 * synchronously in the same call when estimation is enabled, so a typed meal gets a real estimate in
 * the same request rather than waiting on the manual-run retry queue. `servingNote` is persisted
 * on the meal (store/sql.ts's CreateMealInput/Meal) so a later retry via the queue (worker.ts's
 * estimate.run) still has it, unlike the description-only fields the queue's paramsSchema carries.
 *
 * Estimation only runs when `createMeal` actually produced a fresh, never-estimated row
 * (`estimateState === "pending"` and `estimateRevision === 0`): `createMeal` is idempotent on
 * `idempotencyKey` and returns the EXISTING row on a retry (store/sql.ts), so re-estimating on
 * that path would double-call the model for a meal that may already be estimated or already have
 * an estimate in flight via the queue. */
export function createMealsLogHandler(store: FoodStore) {
  return async (ctx: ModuleWorkerContext): Promise<LogMealResult> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, MEALS_LOG_KEYS);

    const description = readString(input, "description", {
      required: true,
      maxBytes: DESCRIPTION_MAX_BYTES
    });
    if (description.trim().length === 0) {
      throw new InputError("description must not be blank");
    }
    const idempotencyKey = readString(input, "idempotencyKey", { required: true });
    const consumedAtRaw = readString(input, "consumedAt");
    const timeZone = readString(input, "timeZone") ?? "UTC";
    const captureKind = readEnum(input, "captureKind", CAPTURE_KINDS) ?? "text";
    const servingNote =
      readString(input, "servingNote", { maxBytes: SERVING_NOTE_MAX_BYTES }) ?? null;

    // consumedAt defaults to "now" when omitted — a real capture-time instant read from the
    // clock at call time, not a computed relative-date render, so this does not fall under the
    // "no ambient dates" convention (that rule targets display-time date arithmetic, e.g.
    // formatting "3 days ago" — see job-search's matches.ts postedAt comment).
    let consumedAt: Date;
    if (consumedAtRaw === undefined) {
      consumedAt = new Date();
    } else {
      const parsed = new Date(consumedAtRaw);
      if (Number.isNaN(parsed.getTime())) {
        throw new InputError("consumedAt must be a valid ISO instant");
      }
      consumedAt = parsed;
    }

    const { localDate, timezoneOffset } = resolveMealLocalDate(consumedAt, timeZone);
    const mealId = crypto.randomUUID();

    const meal = await store.createMeal({
      mealId,
      consumedAt,
      localDate,
      timezoneOffset,
      description,
      servingNote,
      captureKind,
      idempotencyKey
    });

    const isFreshRow = meal.estimateState === "pending" && meal.estimateRevision === 0;
    if (!isFreshRow || !aiEstimatesEnabled(ctx)) {
      return { meal, clarificationQuestion: null };
    }

    const outcome = await estimateFromDescription(ctx.ai, meal.description, meal.servingNote);
    const recorded = await store.recordEstimate(meal.mealId, meal.estimateRevision, {
      state: outcome.kind,
      items: outcome.items,
      nutrients: outcome.nutrients,
      missingDetails: outcome.missingDetails,
      clarificationQuestion: outcome.clarificationQuestion
    });

    // recorded === null only on a lost CAS race between createMeal and recordEstimate above (e.g.
    // a concurrent correction) — vanishingly rare immediately after insert, and store/sql.ts's own
    // convention treats it as "nothing to do", not a failure. The just-created meal (still
    // "pending") is the honest thing to return; a later read reflects whatever won the race.
    return {
      meal: recorded ?? meal,
      clarificationQuestion: outcome.kind === "needs_details" ? outcome.clarificationQuestion : null
    };
  };
}

// ── food.meals.reestimate ───────────────────────────────────────────────

const MEALS_REESTIMATE_KEYS = new Set(["mealId"]);

/**
 * User-facing retry for a meal whose estimate never completed — the second half of
 * food.meals.log, run again against the persisted row. Write-risk, because
 * ai.generateStructured is refused from a read-risk tool (worker-rpc-host.ts:345).
 *
 * Re-estimates only from "pending" or "failed". An already-estimated meal is left
 * alone: correcting a completed estimate is food.meals.correct's job, and silently
 * re-rolling one would discard a value the user may have already accepted.
 *
 * Reads description and servingNote back off the row rather than taking them as
 * input, so a retry reproduces the ORIGINAL input — that is why serving_note is
 * persisted at all (sql/0001).
 */
export function createMealsReestimateHandler(store: FoodStore) {
  return async (
    ctx: ModuleWorkerContext
  ): Promise<{ meal: Meal; clarificationQuestion: string | null }> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, MEALS_REESTIMATE_KEYS);
    const mealId = readString(input, "mealId", { required: true })!;

    const meal = await store.getMeal(mealId);
    if (meal === null) throw new InputError("meal not found");
    if (meal.estimateState !== "pending" && meal.estimateState !== "failed") {
      return { meal, clarificationQuestion: null };
    }
    if (!aiEstimatesEnabled(ctx)) {
      return { meal, clarificationQuestion: null };
    }

    const outcome = await estimateFromDescription(ctx.ai, meal.description, meal.servingNote);
    const recorded = await store.recordEstimate(meal.mealId, meal.estimateRevision, {
      state: outcome.kind,
      items: outcome.items,
      nutrients: outcome.nutrients,
      missingDetails: outcome.missingDetails,
      clarificationQuestion: outcome.clarificationQuestion
    });
    return {
      meal: recorded ?? meal,
      clarificationQuestion: outcome.kind === "needs_details" ? outcome.clarificationQuestion : null
    };
  };
}

// ── food.meals.correct ──────────────────────────────────────────────────

// timeZone is NOT in the plan's fixed CorrectMealInput signature (plan §4 Task 4) — added here as
// an OPTIONAL extra field to make a `consumedAt` correction re-resolve `localDate`/`timezoneOffset`
// with full DST-aware Intl logic (constraint 9) rather than only the fixed-offset fallback below.
// Flagged in this task's report as a plan gap, not a silent deviation.
const MEALS_CORRECT_KEYS = new Set([
  "mealId",
  "expectedRevision",
  "description",
  "consumedAt",
  "timeZone",
  "items"
]);

const CORRECT_ITEM_KEYS = new Set(["label", "portionNote", "nutrients"]);

const NUTRIENT_KEYS = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const satisfies readonly (keyof Nutrients)[];

/** Fixed-offset fallback for re-resolving `localDate` when `consumedAt` changes but no `timeZone`
 * is given. Deliberately NOT the `.slice(0,10)`-on-a-raw-UTC-instant pattern domain/meal.ts's
 * header comment forbids — the offset is applied to the instant FIRST (shifting it into "local
 * clock time expressed as UTC"), then the calendar day is read off the shifted instant. This is
 * the meal's PREVIOUS offset (persisted at create/last-correct time), so it degrades gracefully
 * near a DST boundary rather than being DST-correct — an approximation, not resolveMealLocalDate's
 * full Intl-based resolution, which needs an IANA zone name this input does not always have. */
function localDateAtFixedOffset(consumedAt: Date, offsetMinutes: number): string {
  const shifted = new Date(consumedAt.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function readNutrientsPatch(raw: unknown, path: string): Partial<Nutrients> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError(`${path} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(NUTRIENT_KEYS as readonly string[]).includes(key)) {
      throw new InputError(`unknown key: ${path}.${key}`);
    }
  }
  const caloriesKcal = readNutrientValue(record, "caloriesKcal");
  const proteinG = readNutrientValue(record, "proteinG");
  const carbohydratesG = readNutrientValue(record, "carbohydratesG");
  const fatG = readNutrientValue(record, "fatG");
  const fiberG = readNutrientValue(record, "fiberG");
  const sugarG = readNutrientValue(record, "sugarG");
  const sodiumMg = readNutrientValue(record, "sodiumMg");
  // Explicit per-field construction (never a cast across the Record<string,...>-to-Partial<Nutrients>
  // gap): each spread only contributes a key the caller actually supplied.
  return {
    ...(caloriesKcal !== undefined ? { caloriesKcal } : {}),
    ...(proteinG !== undefined ? { proteinG } : {}),
    ...(carbohydratesG !== undefined ? { carbohydratesG } : {}),
    ...(fatG !== undefined ? { fatG } : {}),
    ...(fiberG !== undefined ? { fiberG } : {}),
    ...(sugarG !== undefined ? { sugarG } : {}),
    ...(sodiumMg !== undefined ? { sodiumMg } : {})
  };
}

/**
 * Reads an item-level correction (#1737). Entry i of the array corrects item i
 * of the meal's current breakdown; `null` leaves that item alone, which is how
 * a caller reaches item 3 without restating items 1 and 2. An entry past the
 * end of the list adds an item, and the store requires it to carry a label.
 *
 * There is deliberately no meal-level `nutrients` patch any more: a meal's
 * figures are the sum of its items, so a number written straight onto the meal
 * would contradict the breakdown shown underneath it.
 */
function readItemsPatch(input: Record<string, unknown>): CorrectMealItemPatch[] | undefined {
  const raw = input["items"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new InputError("items must be an array");
  }
  return raw.map((entry, index) => {
    if (entry === null) return {};
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new InputError(`items[${index}] must be an object or null`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!CORRECT_ITEM_KEYS.has(key)) {
        throw new InputError(`unknown key: items[${index}].${key}`);
      }
    }
    const label = readString(record, "label", { maxBytes: ITEM_LABEL_MAX_BYTES });
    if (label !== undefined && label.trim().length === 0) {
      throw new InputError(`items[${index}].label must not be blank`);
    }
    const portionNoteRaw = record["portionNote"];
    let portionNote: string | null | undefined;
    if (portionNoteRaw === null) portionNote = null;
    else portionNote = readString(record, "portionNote", { maxBytes: ITEM_PORTION_MAX_BYTES });
    const nutrients = readNutrientsPatch(record["nutrients"], `items[${index}].nutrients`);
    return {
      ...(label !== undefined ? { label } : {}),
      ...(portionNote !== undefined ? { portionNote } : {}),
      ...(nutrients !== undefined ? { nutrients } : {})
    };
  });
}

/** `food.meals.correct` — write. Revision-guarded (CAS on `expectedRevision`); the store rejects a
 * stale or unknown `mealId` identically (returns null either way, see store/sql.ts's correctMeal),
 * so this handler cannot distinguish "not found" from "stale revision" and does not try to. */
export function createMealsCorrectHandler(store: FoodStore) {
  return async (ctx: ModuleWorkerContext): Promise<Meal> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, MEALS_CORRECT_KEYS);

    const mealId = readString(input, "mealId", { required: true });
    const expectedRevision = readInt(input, "expectedRevision", { required: true, min: 0 });
    const description = readString(input, "description", { maxBytes: DESCRIPTION_MAX_BYTES });
    if (description !== undefined && description.trim().length === 0) {
      throw new InputError("description must not be blank");
    }
    const consumedAtRaw = readString(input, "consumedAt");
    const timeZone = readString(input, "timeZone");
    const items = readItemsPatch(input);

    let consumedAtFields:
      | { consumedAt: Date; localDate: string; timezoneOffset: number }
      | undefined;
    if (consumedAtRaw !== undefined) {
      const consumedAt = new Date(consumedAtRaw);
      if (Number.isNaN(consumedAt.getTime())) {
        throw new InputError("consumedAt must be a valid ISO instant");
      }
      let localDate: string;
      let timezoneOffset: number;
      if (timeZone !== undefined) {
        ({ localDate, timezoneOffset } = resolveMealLocalDate(consumedAt, timeZone));
      } else {
        const existing = await store.getMeal(mealId);
        if (existing === null) {
          throw new InputError("mealId not found");
        }
        timezoneOffset = existing.timezoneOffset;
        localDate = localDateAtFixedOffset(consumedAt, timezoneOffset);
      }
      consumedAtFields = { consumedAt, localDate, timezoneOffset };
    }

    // Explicit per-field construction (never a cast into CorrectMealPatch): each spread only
    // contributes the keys the caller actually supplied, matching store/sql.ts's own contract
    // that an unspecified field keeps its current value rather than being nulled by omission.
    const patch: CorrectMealPatch = {
      ...(description !== undefined ? { description } : {}),
      ...(consumedAtFields ?? {}),
      ...(items !== undefined ? { items } : {})
    };

    const result = await store.correctMeal(mealId, expectedRevision, patch);
    if (result === null) {
      throw new InputError("meal not found or expectedRevision is stale");
    }
    return result;
  };
}

// ── food.meals.delete ───────────────────────────────────────────────────

export interface DeleteMealResult {
  readonly mealId: string;
  readonly deleted: true;
}

/** `food.meals.delete` — destructive. Goes through the platform's existing confirmation flow
 * before this handler is ever reached (manifest `risk: "destructive"`); this handler itself just
 * performs the delete and reports whether a row existed to delete. */
export function createMealsDeleteHandler(store: FoodStore) {
  return async (ctx: ModuleWorkerContext): Promise<DeleteMealResult> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, new Set(["mealId"]));
    const mealId = readString(input, "mealId", { required: true });

    const deleted = await store.deleteMeal(mealId);
    if (!deleted) {
      throw new InputError("mealId not found");
    }
    return { mealId, deleted: true };
  };
}
