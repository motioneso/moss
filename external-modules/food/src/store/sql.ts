// external-modules/food/src/store/sql.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 3): repository over the module's
// two owned tables, app.food_meals and app.food_estimates. Every query is
// owner-scoped by the platform's FORCE RLS policy plus
// app.current_actor_user_id() on writes — no method here takes or accepts a
// caller-supplied owner id (two-actor privacy, plan §4 Task 7 test 9).
//
// Follows external-modules/finance/src/domain/store-sql.ts's shape: a
// structural `FoodDb` (never imports @moss/*, so this file stays bundler-
// independent — matching the "domain files never import @moss/*" convention
// extended here to the whole prebuilt module artifact) and a `sqlStore(db)`
// factory. Every statement here IS the contract; a drift silently changes
// what RLS sees, so the SQL text is deliberately explicit rather than
// built through a query builder.
//
// The host's db.query allows SELECT/INSERT/UPDATE/DELETE only (no
// transactions) — see ModuleWorkerContext.db's doc comment
// (packages/module-sdk/src/worker.ts). Multi-statement operations below
// (recordEstimate, correctMeal) are therefore a CAS UPDATE on food_meals
// followed by an INSERT on food_estimates, not a single transaction; the CAS
// on estimate_revision is what keeps a stale writer from clobbering a newer
// one, not atomicity.

import type { CaptureKind, EstimateState, Meal, Nutrients } from "../domain/meal.js";

/** Structural twin of ModuleWorkerContext.db — see the file header. */
export interface FoodDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

// ── Row <-> domain mapping ──────────────────────────────────────────────

const MEAL_COLUMNS =
  "meal_id, consumed_at, local_date, timezone_offset, description, serving_note, capture_kind, " +
  "estimate_state, estimate_revision, idempotency_key";

/** Joined meal + its current-revision estimate (LEFT JOIN, so revision 0 / no estimate yet is fine). */
const MEAL_JOIN_ESTIMATE = `
  SELECT m.meal_id, m.consumed_at, m.local_date, m.timezone_offset, m.description,
    m.serving_note, m.capture_kind, m.estimate_state, m.estimate_revision,
    e.calories_kcal, e.protein_g, e.carbohydrates_g, e.fat_g, e.fiber_g, e.sugar_g,
    e.sodium_mg, e.missing_details
  FROM app.food_meals m
  LEFT JOIN app.food_estimates e
    ON e.owner_user_id = m.owner_user_id AND e.meal_id = m.meal_id AND e.revision = m.estimate_revision
`;

type MealRow = {
  meal_id: string;
  consumed_at: unknown; // driver-dependent: Date instance or text, normalized by toIsoString
  local_date: string;
  timezone_offset: number;
  description: string;
  serving_note: string | null;
  capture_kind: CaptureKind;
  estimate_state: EstimateState;
  estimate_revision: number;
  calories_kcal: string | number | null;
  protein_g: string | number | null;
  carbohydrates_g: string | number | null;
  fat_g: string | number | null;
  fiber_g: string | number | null;
  sugar_g: string | number | null;
  sodium_mg: string | number | null;
  missing_details: string | null;
};

/** numeric(...) columns round-trip as strings on most drivers; coerce, preserving null. */
function toNutrientNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function rowToMeal(row: MealRow): Meal {
  // Only an "estimated" meal carries nutrients. If the join found no matching
  // food_estimates row (should not happen once recordEstimate has run, but
  // the join is LEFT so this stays defensive), every nutrient maps to null
  // rather than throwing — toNutrientNumber(null) is null either way.
  const nutrients: Nutrients | null =
    row.estimate_state === "estimated"
      ? {
          caloriesKcal: toNutrientNumber(row.calories_kcal),
          proteinG: toNutrientNumber(row.protein_g),
          carbohydratesG: toNutrientNumber(row.carbohydrates_g),
          fatG: toNutrientNumber(row.fat_g),
          fiberG: toNutrientNumber(row.fiber_g),
          sugarG: toNutrientNumber(row.sugar_g),
          sodiumMg: toNutrientNumber(row.sodium_mg)
        }
      : null;
  return {
    mealId: row.meal_id,
    consumedAt: toIsoString(row.consumed_at),
    localDate: row.local_date,
    timezoneOffset: row.timezone_offset,
    description: row.description,
    servingNote: row.serving_note,
    captureKind: row.capture_kind,
    estimateState: row.estimate_state,
    estimateRevision: row.estimate_revision,
    nutrients,
    missingDetails: row.estimate_state === "needs_details" ? row.missing_details : null
  };
}

// ── Repository ───────────────────────────────────────────────────────────

export interface CreateMealInput {
  readonly mealId: string;
  readonly consumedAt: Date;
  readonly localDate: string;
  readonly timezoneOffset: number;
  readonly description: string;
  readonly servingNote: string | null;
  readonly captureKind: CaptureKind;
  readonly idempotencyKey: string;
}

export interface RecordEstimateInput {
  readonly state: Exclude<EstimateState, "pending">;
  readonly nutrients: Nutrients | null;
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

export interface CorrectMealPatch {
  readonly description?: string;
  readonly consumedAt?: Date;
  readonly localDate?: string;
  readonly timezoneOffset?: number;
  /** Unspecified nutrient fields keep their current value — never nulled by omission. */
  readonly nutrients?: Partial<Nutrients>;
}

export interface FoodStore {
  /** Owner-scoped by app.current_actor_user_id() at insert time. Idempotent on idempotencyKey. */
  createMeal(input: CreateMealInput): Promise<Meal>;
  getMeal(mealId: string): Promise<Meal | null>;
  /** Meals on one local date, consumed_at ascending — the page's primary read. */
  listMealsForLocalDate(localDate: string): Promise<Meal[]>;
  /** Inclusive [fromLocalDate, toLocalDate] range, consumed_at ascending. */
  listMealsForDateRange(fromLocalDate: string, toLocalDate: string): Promise<Meal[]>;
  /**
   * Applies an estimator outcome. CAS-guarded on expectedRevision (the
   * meal's estimate_revision at the time estimation was requested) so a
   * stale worker retry — or a race with a user correction — cannot
   * overwrite newer state. Returns null when the CAS fails (meal moved on
   * or was deleted); the caller (Task 5) treats that as "nothing to do".
   */
  recordEstimate(
    mealId: string,
    expectedRevision: number,
    outcome: RecordEstimateInput
  ): Promise<Meal | null>;
  /**
   * User-authored correction. Same CAS guard as recordEstimate — a stale
   * expectedRevision is rejected with null, no write (plan §4 Task 7 test
   * 7). Nutrient corrections are always trusted (user-authored, not
   * model-authored) and merged over the current estimate rather than
   * replacing it, so correcting one field never blanks the rest.
   */
  correctMeal(
    mealId: string,
    expectedRevision: number,
    patch: CorrectMealPatch
  ): Promise<Meal | null>;
  deleteMeal(mealId: string): Promise<boolean>;
}

export function sqlStore(db: FoodDb): FoodStore {
  return {
    async createMeal(input) {
      const inserted = await db.query<MealRow>(
        `WITH ins AS (
           INSERT INTO app.food_meals (
             owner_user_id, meal_id, consumed_at, local_date, timezone_offset,
             description, serving_note, capture_kind, estimate_state, estimate_revision, idempotency_key
           )
           VALUES (
             app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8
           )
           ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
           RETURNING ${MEAL_COLUMNS}
         )
         SELECT ins.meal_id, ins.consumed_at, ins.local_date, ins.timezone_offset, ins.description,
           ins.serving_note, ins.capture_kind, ins.estimate_state, ins.estimate_revision,
           NULL::numeric AS calories_kcal, NULL::numeric AS protein_g,
           NULL::numeric AS carbohydrates_g, NULL::numeric AS fat_g, NULL::numeric AS fiber_g,
           NULL::numeric AS sugar_g, NULL::numeric AS sodium_mg, NULL::text AS missing_details
         FROM ins`,
        [
          input.mealId,
          input.consumedAt,
          input.localDate,
          input.timezoneOffset,
          input.description,
          input.servingNote,
          input.captureKind,
          input.idempotencyKey
        ]
      );
      if (inserted.rows.length > 0) return rowToMeal(inserted.rows[0]!);

      // Conflict on (owner_user_id, idempotency_key): a retry of an already-logged
      // meal. Return the existing row rather than erroring — one row either way
      // (plan §4 Task 7 test 2).
      const existing = await db.query<MealRow>(
        `${MEAL_JOIN_ESTIMATE} WHERE m.idempotency_key = $1`,
        [input.idempotencyKey]
      );
      if (existing.rows.length === 0) {
        throw new Error("food.meals.log: idempotency conflict but no existing row found");
      }
      return rowToMeal(existing.rows[0]!);
    },

    async getMeal(mealId) {
      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : rowToMeal(result.rows[0]!);
    },

    async listMealsForLocalDate(localDate) {
      const result = await db.query<MealRow>(
        `${MEAL_JOIN_ESTIMATE} WHERE m.local_date = $1 ORDER BY m.consumed_at ASC`,
        [localDate]
      );
      return result.rows.map(rowToMeal);
    },

    async listMealsForDateRange(fromLocalDate, toLocalDate) {
      const result = await db.query<MealRow>(
        `${MEAL_JOIN_ESTIMATE} WHERE m.local_date BETWEEN $1 AND $2 ORDER BY m.consumed_at ASC`,
        [fromLocalDate, toLocalDate]
      );
      return result.rows.map(rowToMeal);
    },

    async recordEstimate(mealId, expectedRevision, outcome) {
      const updated = await db.query<{ estimate_revision: number }>(
        `UPDATE app.food_meals
         SET estimate_state = $3, estimate_revision = estimate_revision + 1, updated_at = now()
         WHERE meal_id = $1 AND estimate_revision = $2
         RETURNING estimate_revision`,
        [mealId, expectedRevision, outcome.state]
      );
      if (updated.rows.length === 0) return null; // stale revision or meal gone: nothing to apply

      const newRevision = updated.rows[0]!.estimate_revision;
      const n = outcome.nutrients;
      await db.query(
        `INSERT INTO app.food_estimates (
           owner_user_id, meal_id, revision, calories_kcal, protein_g, carbohydrates_g,
           fat_g, fiber_g, sugar_g, sodium_mg, missing_details, clarification_question
         )
         VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          mealId,
          newRevision,
          n?.caloriesKcal ?? null,
          n?.proteinG ?? null,
          n?.carbohydratesG ?? null,
          n?.fatG ?? null,
          n?.fiberG ?? null,
          n?.sugarG ?? null,
          n?.sodiumMg ?? null,
          outcome.missingDetails,
          outcome.clarificationQuestion
        ]
      );

      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : rowToMeal(result.rows[0]!);
    },

    async correctMeal(mealId, expectedRevision, patch) {
      // Read the pre-correction nutrients so a partial nutrient patch merges
      // over them rather than blanking unspecified fields (guard 4 of the
      // determinism boundary: correction never silently discards a value
      // the user didn't touch).
      const current = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      if (current.rows.length === 0 || current.rows[0]!.estimate_revision !== expectedRevision) {
        return null;
      }
      const currentMeal = rowToMeal(current.rows[0]!);

      const nextState: EstimateState = patch.nutrients ? "estimated" : currentMeal.estimateState;
      const updated = await db.query<{ estimate_revision: number }>(
        `UPDATE app.food_meals
         SET description = COALESCE($3, description),
             consumed_at = COALESCE($4, consumed_at),
             local_date = COALESCE($5, local_date),
             timezone_offset = COALESCE($6, timezone_offset),
             estimate_state = $7,
             estimate_revision = estimate_revision + 1,
             updated_at = now()
         WHERE meal_id = $1 AND estimate_revision = $2
         RETURNING estimate_revision`,
        [
          mealId,
          expectedRevision,
          patch.description ?? null,
          patch.consumedAt ?? null,
          patch.localDate ?? null,
          patch.timezoneOffset ?? null,
          nextState
        ]
      );
      if (updated.rows.length === 0) return null; // lost the CAS race between the read above and here

      if (patch.nutrients) {
        const base = currentMeal.nutrients;
        const merged: Nutrients = {
          caloriesKcal: patch.nutrients.caloriesKcal ?? base?.caloriesKcal ?? null,
          proteinG: patch.nutrients.proteinG ?? base?.proteinG ?? null,
          carbohydratesG: patch.nutrients.carbohydratesG ?? base?.carbohydratesG ?? null,
          fatG: patch.nutrients.fatG ?? base?.fatG ?? null,
          fiberG: patch.nutrients.fiberG ?? base?.fiberG ?? null,
          sugarG: patch.nutrients.sugarG ?? base?.sugarG ?? null,
          sodiumMg: patch.nutrients.sodiumMg ?? base?.sodiumMg ?? null
        };
        const newRevision = updated.rows[0]!.estimate_revision;
        await db.query(
          `INSERT INTO app.food_estimates (
             owner_user_id, meal_id, revision, calories_kcal, protein_g, carbohydrates_g,
             fat_g, fiber_g, sugar_g, sodium_mg, missing_details, clarification_question
           )
           VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL)`,
          [
            mealId,
            newRevision,
            merged.caloriesKcal,
            merged.proteinG,
            merged.carbohydratesG,
            merged.fatG,
            merged.fiberG,
            merged.sugarG,
            merged.sodiumMg
          ]
        );
      }

      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : rowToMeal(result.rows[0]!);
    },

    async deleteMeal(mealId) {
      const result = await db.query<{ meal_id: string }>(
        `DELETE FROM app.food_meals WHERE meal_id = $1 RETURNING meal_id`,
        [mealId]
      );
      return result.rows.length > 0;
    }
  } satisfies FoodStore;
}
