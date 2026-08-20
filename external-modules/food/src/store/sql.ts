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

import type { CaptureKind, EstimateState, Meal, MealItem, Nutrients } from "../domain/meal.js";
import { sumItemNutrients } from "../domain/totals.js";

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

type ItemRow = {
  meal_id: string;
  item_index: number;
  label: string;
  portion_note: string | null;
  calories_kcal: string | number | null;
  protein_g: string | number | null;
  carbohydrates_g: string | number | null;
  fat_g: string | number | null;
  fiber_g: string | number | null;
  sugar_g: string | number | null;
  sodium_mg: string | number | null;
};

function rowToItem(row: ItemRow): MealItem {
  return {
    label: row.label,
    portionNote: row.portion_note,
    nutrients: {
      caloriesKcal: toNutrientNumber(row.calories_kcal),
      proteinG: toNutrientNumber(row.protein_g),
      carbohydratesG: toNutrientNumber(row.carbohydrates_g),
      fatG: toNutrientNumber(row.fat_g),
      fiberG: toNutrientNumber(row.fiber_g),
      sugarG: toNutrientNumber(row.sugar_g),
      sodiumMg: toNutrientNumber(row.sodium_mg)
    }
  };
}

/**
 * Items for a set of meals, at each meal's CURRENT revision — the join on
 * estimate_revision is what keeps a correction from resurrecting the previous
 * revision's breakdown alongside the new one. Returned keyed by meal id, in
 * item_index order; a meal with no breakdown (logged before #1737, or not yet
 * estimated) is simply absent from the map.
 *
 * This is a second query rather than a join onto MEAL_JOIN_ESTIMATE because
 * that query returns one row per meal and items are one-to-many — joining
 * would multiply every meal row by its item count and force de-duplication in
 * TypeScript.
 */
async function loadItemsByMeal(
  db: FoodDb,
  mealIds: readonly string[]
): Promise<Map<string, MealItem[]>> {
  const byMeal = new Map<string, MealItem[]>();
  if (mealIds.length === 0) return byMeal;
  const { rows } = await db.query<ItemRow>(
    `SELECT i.meal_id, i.item_index, i.label, i.portion_note, i.calories_kcal, i.protein_g,
       i.carbohydrates_g, i.fat_g, i.fiber_g, i.sugar_g, i.sodium_mg
     FROM app.food_estimate_items i
     JOIN app.food_meals m
       ON m.owner_user_id = i.owner_user_id AND m.meal_id = i.meal_id
       AND m.estimate_revision = i.revision
     WHERE i.meal_id = ANY($1::uuid[])
     ORDER BY i.meal_id, i.item_index`,
    [mealIds]
  );
  for (const row of rows) {
    const existing = byMeal.get(row.meal_id);
    if (existing) existing.push(rowToItem(row));
    else byMeal.set(row.meal_id, [rowToItem(row)]);
  }
  return byMeal;
}

/** Maps meal rows and attaches each meal's items in one extra round trip. */
async function rowsToMeals(db: FoodDb, rows: readonly MealRow[]): Promise<Meal[]> {
  const byMeal = await loadItemsByMeal(
    db,
    rows.map((row) => row.meal_id)
  );
  return rows.map((row) => rowToMeal(row, byMeal.get(row.meal_id) ?? []));
}

function rowToMeal(row: MealRow, items: readonly MealItem[]): Meal {
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
    items,
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
  /** The individual foods. The estimate row's nutrients are written as their sum. */
  readonly items: readonly MealItem[];
  readonly nutrients: Nutrients | null;
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

/**
 * One item of a correction, merged positionally over the meal's current items:
 * an omitted field keeps the value the item already had (guard 4 — a correction
 * never blanks something the user did not touch). An entry past the end of the
 * current list is a new item and must carry a label.
 */
export interface CorrectMealItemPatch {
  readonly label?: string;
  readonly portionNote?: string | null;
  readonly nutrients?: Partial<Nutrients>;
}

export interface CorrectMealPatch {
  readonly description?: string;
  readonly consumedAt?: Date;
  readonly localDate?: string;
  readonly timezoneOffset?: number;
  /**
   * Corrections are item-level (#1737). There is deliberately no meal-level
   * nutrient patch: the meal's numbers are always the sum of its items, so a
   * figure written straight onto the meal would contradict its own breakdown.
   */
  readonly items?: readonly CorrectMealItemPatch[];
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
   * model-authored) and merged over the current breakdown rather than
   * replacing it, so correcting one field never blanks the rest. Corrections
   * are per item; the meal's totals are re-derived from the corrected items,
   * never written directly (#1737).
   */
  correctMeal(
    mealId: string,
    expectedRevision: number,
    patch: CorrectMealPatch
  ): Promise<Meal | null>;
  deleteMeal(mealId: string): Promise<boolean>;
}

/**
 * Writes the breakdown for one revision. One multi-row INSERT rather than one
 * statement per item — the host's db port allows no transaction, so fewer
 * statements is fewer ways to land half a breakdown. Nothing is deleted first:
 * item rows are keyed by revision and every write here is at a revision that
 * did not exist a moment ago.
 */
async function insertItems(
  db: FoodDb,
  mealId: string,
  revision: number,
  items: readonly MealItem[]
): Promise<void> {
  if (items.length === 0) return;
  const params: unknown[] = [mealId, revision];
  const tuples = items.map((item, index) => {
    const base = params.length;
    params.push(
      index,
      item.label,
      item.portionNote,
      item.nutrients.caloriesKcal,
      item.nutrients.proteinG,
      item.nutrients.carbohydratesG,
      item.nutrients.fatG,
      item.nutrients.fiberG,
      item.nutrients.sugarG,
      item.nutrients.sodiumMg
    );
    const p = (offset: number) => `$${base + offset}`;
    return (
      `(app.current_actor_user_id(), $1, $2, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ` +
      `${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)})`
    );
  });
  await db.query(
    `INSERT INTO app.food_estimate_items (
       owner_user_id, meal_id, revision, item_index, label, portion_note, calories_kcal,
       protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg
     )
     VALUES ${tuples.join(", ")}`,
    params
  );
}

/**
 * Positional merge of a correction over the meal's current breakdown. Index i
 * of the patch corrects item i; an omitted field keeps what the item already
 * had, and an entry past the end of the current list is a new item (which the
 * caller has already checked carries a label). Items the patch does not reach
 * are carried forward unchanged.
 */
function mergeItems(
  current: readonly MealItem[],
  patch: readonly CorrectMealItemPatch[]
): MealItem[] {
  const length = Math.max(current.length, patch.length);
  const merged: MealItem[] = [];
  for (let index = 0; index < length; index += 1) {
    const base = current[index];
    const change = patch[index];
    if (!change) {
      if (base) merged.push(base);
      continue;
    }
    const n = change.nutrients;
    const label = change.label ?? base?.label;
    if (label === undefined || label.trim() === "") {
      // A patch entry past the end of the current list is a NEW item, and an
      // item with no name cannot be rendered or corrected later. Rejected here
      // rather than at the database, where it would surface as a check-constraint
      // violation with no useful message.
      throw new Error(`food.correct: items[${index}] is new and needs a label`);
    }
    merged.push({
      label,
      portionNote:
        change.portionNote !== undefined ? change.portionNote : (base?.portionNote ?? null),
      nutrients: {
        caloriesKcal: n?.caloriesKcal ?? base?.nutrients.caloriesKcal ?? null,
        proteinG: n?.proteinG ?? base?.nutrients.proteinG ?? null,
        carbohydratesG: n?.carbohydratesG ?? base?.nutrients.carbohydratesG ?? null,
        fatG: n?.fatG ?? base?.nutrients.fatG ?? null,
        fiberG: n?.fiberG ?? base?.nutrients.fiberG ?? null,
        sugarG: n?.sugarG ?? base?.nutrients.sugarG ?? null,
        sodiumMg: n?.sodiumMg ?? base?.nutrients.sodiumMg ?? null
      }
    });
  }
  return merged;
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
      // A meal that was inserted a statement ago has no breakdown yet — no
      // estimator has run — so this one path skips the items round trip.
      if (inserted.rows.length > 0) return rowToMeal(inserted.rows[0]!, []);

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
      return (await rowsToMeals(db, existing.rows))[0]!;
    },

    async getMeal(mealId) {
      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : (await rowsToMeals(db, result.rows))[0]!;
    },

    async listMealsForLocalDate(localDate) {
      const result = await db.query<MealRow>(
        `${MEAL_JOIN_ESTIMATE} WHERE m.local_date = $1 ORDER BY m.consumed_at ASC`,
        [localDate]
      );
      return rowsToMeals(db, result.rows);
    },

    async listMealsForDateRange(fromLocalDate, toLocalDate) {
      const result = await db.query<MealRow>(
        `${MEAL_JOIN_ESTIMATE} WHERE m.local_date BETWEEN $1 AND $2 ORDER BY m.consumed_at ASC`,
        [fromLocalDate, toLocalDate]
      );
      return rowsToMeals(db, result.rows);
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
      // After the estimate row, never before: the item rows reference it by
      // (owner, meal, revision), so the reverse order fails the foreign key.
      await insertItems(db, mealId, newRevision, outcome.items);

      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : (await rowsToMeals(db, result.rows))[0]!;
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
      const currentMeal = (await rowsToMeals(db, current.rows))[0]!;

      // Merged before the CAS UPDATE so a patch that cannot be applied (a new
      // item with no label) fails without having advanced the revision.
      const mergedItems = patch.items ? mergeItems(currentMeal.items, patch.items) : null;
      const nextState: EstimateState = mergedItems ? "estimated" : currentMeal.estimateState;
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

      const newRevision = updated.rows[0]!.estimate_revision;
      if (mergedItems) {
        // Derived, never patched directly (#1737): whatever the user corrected
        // on an item, the meal's figures are the sum of the items afterwards.
        const merged: Nutrients = sumItemNutrients(mergedItems);
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
        await insertItems(db, mealId, newRevision, mergedItems);
      } else {
        // A correction that only touched text or time still advances the
        // revision, and the estimate is read at the CURRENT revision — so
        // without this copy an edited description would silently blank the
        // meal's nutrition. Both statements are no-ops when there is nothing
        // at the previous revision to carry (a meal that never estimated).
        await db.query(
          `INSERT INTO app.food_estimates (
             owner_user_id, meal_id, revision, calories_kcal, protein_g, carbohydrates_g,
             fat_g, fiber_g, sugar_g, sodium_mg, missing_details, clarification_question
           )
           SELECT owner_user_id, meal_id, $2, calories_kcal, protein_g, carbohydrates_g,
             fat_g, fiber_g, sugar_g, sodium_mg, missing_details, clarification_question
           FROM app.food_estimates WHERE meal_id = $1 AND revision = $3`,
          [mealId, newRevision, expectedRevision]
        );
        await db.query(
          `INSERT INTO app.food_estimate_items (
             owner_user_id, meal_id, revision, item_index, label, portion_note, calories_kcal,
             protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg
           )
           SELECT owner_user_id, meal_id, $2, item_index, label, portion_note, calories_kcal,
             protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg
           FROM app.food_estimate_items WHERE meal_id = $1 AND revision = $3`,
          [mealId, newRevision, expectedRevision]
        );
      }

      const result = await db.query<MealRow>(`${MEAL_JOIN_ESTIMATE} WHERE m.meal_id = $1`, [
        mealId
      ]);
      return result.rows.length === 0 ? null : (await rowsToMeals(db, result.rows))[0]!;
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
