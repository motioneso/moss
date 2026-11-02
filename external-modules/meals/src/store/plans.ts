// external-modules/meals/src/store/plans.ts
//
// The SQL PlanStore. RLS scopes every query to the acting owner, so owners appear only through
// app.current_actor_user_id() on insert.
//
// ctx.db has no transactions. Writes that must not race compare a generation in their WHERE
// clause, and a write that spans tables is one statement of data-modifying WITH clauses, which
// Postgres applies together or not at all and runs whether or not the final SELECT reads them.
// Foreign keys between sibling clauses hold because they are checked at the end of the statement.
import type { GenerationFailure, WriteStatus } from "../contracts.js";
import { titleKey } from "../domain/repeats.js";
import type {
  DayRow,
  MealEaterRow,
  MealRow,
  PlanRow,
  PlanState,
  PlanStore,
  RecipeRow,
  SwapChoiceRow
} from "./plan-port.js";
import type { MealsDb } from "./sql.js";

const NAME_KEY_LENGTH = 80;

/**
 * A day claim waits while another day in the plan is writing. A writing day older than the
 * queue's ten-minute ceiling plus a minute is a killed job, so it no longer blocks.
 */
const WRITING_LEASE_SECONDS = 660;

const PLAN_COLUMNS =
  'plan_id AS "planId", kitchen_id AS "kitchenId", start_date::text AS "startDate", ' +
  'day_count AS "dayCount", pantry_mode AS "pantryMode", request_text AS "requestText", ' +
  'allow_repeats AS "allowRepeats", state, paused_reason AS "pausedReason"';

const DAY_COLUMNS =
  'day_id AS "dayId", plan_id AS "planId", day_date::text AS date, status, ' +
  'failure_reason AS "failureReason", cook_time_limit_minutes AS "cookTimeLimitMinutes", ' +
  "generation";

/** Meal columns on alias m, with its eaters folded in as JSON. */
const MEAL_COLUMNS =
  'm.meal_id AS "mealId", m.day_id AS "dayId", m.slot_name AS "slotName", ' +
  'm.slot_position AS "slotPosition", m.kind, m.sharing, m.status, ' +
  'm.failure_reason AS "failureReason", m.locked, m.one_off_for AS "oneOffFor", ' +
  'm.favourite_of AS "favouriteOf", m.servings_override::float8 AS "servingsOverride", ' +
  'm.recipe_id AS "recipeId", m.plain_text AS "plainText", ' +
  "to_json(m.cooked_at) #>> '{}' AS \"cookedAt\", m.attempts, m.generation, " +
  "coalesce((SELECT jsonb_agg(jsonb_build_object(" +
  "'memberId', e.member_id, 'portion', e.portion::float8, 'estimatedKcal', e.estimated_kcal, " +
  "'safety', e.safety, 'safetyReason', e.safety_reason) ORDER BY e.created_at, e.member_id) " +
  "FROM app.meals_planned_meal_eaters e WHERE e.meal_id = m.meal_id), '[]'::jsonb) AS eaters";

function nameKey(name: string): string {
  return titleKey(name).slice(0, NAME_KEY_LENGTH).trim() || "item";
}

export function sqlPlanStore(db: MealsDb): PlanStore {
  async function one<T>(text: string, params: readonly unknown[]): Promise<T | null> {
    const { rows } = await db.query<T>(text, params);
    return rows[0] ?? null;
  }

  return {
    async createPlan(input) {
      const days = input.days.map((day) => ({ day_id: day.dayId, day_date: day.date }));
      const meals = input.meals.map((meal) => ({
        meal_id: meal.mealId,
        day_id: meal.dayId,
        slot_name: meal.slotName,
        slot_position: meal.slotPosition,
        sharing: meal.sharing
      }));
      const eaters = input.meals.flatMap((meal) =>
        meal.eaterIds.map((memberId) => ({ meal_id: meal.mealId, member_id: memberId }))
      );
      const row = await one<{ planId: string | null }>(
        "WITH p AS (INSERT INTO app.meals_plans (owner_user_id, kitchen_id, plan_id, start_date, " +
          "day_count, pantry_mode, request_text, allow_repeats, idempotency_key) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3::date, $4, $5, $6, $7, $8) " +
          "ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING RETURNING plan_id), " +
          "d AS (INSERT INTO app.meals_plan_days (owner_user_id, kitchen_id, plan_id, day_id, " +
          "day_date, generation) SELECT app.current_actor_user_id(), $1, p.plan_id, x.day_id, " +
          "x.day_date, 0 FROM p, jsonb_to_recordset($9::jsonb) AS x(day_id uuid, day_date date) " +
          "RETURNING 1), " +
          "m AS (INSERT INTO app.meals_planned_meals (owner_user_id, kitchen_id, day_id, meal_id, " +
          "slot_name, slot_position, kind, sharing, generation) " +
          "SELECT app.current_actor_user_id(), $1, x.day_id, x.meal_id, x.slot_name, " +
          "x.slot_position, 'recipe', x.sharing, 0 FROM p, jsonb_to_recordset($10::jsonb) " +
          "AS x(meal_id uuid, day_id uuid, slot_name text, slot_position smallint, sharing text) " +
          "RETURNING 1), " +
          "e AS (INSERT INTO app.meals_planned_meal_eaters (owner_user_id, kitchen_id, meal_id, " +
          "member_id) SELECT app.current_actor_user_id(), $1, x.meal_id, x.member_id FROM p, " +
          "jsonb_to_recordset($11::jsonb) AS x(meal_id uuid, member_id uuid) RETURNING 1) " +
          'SELECT (SELECT plan_id FROM p) AS "planId"',
        [
          input.kitchenId,
          input.planId,
          input.startDate,
          input.dayCount,
          input.pantryMode,
          input.requestText,
          input.allowRepeats,
          input.idempotencyKey,
          JSON.stringify(days),
          JSON.stringify(meals),
          JSON.stringify(eaters)
        ]
      );
      if (row?.planId) return { created: true, planId: row.planId };
      const existing = await this.findPlanByKey(input.idempotencyKey);
      if (existing === null) throw new Error("plan not visible after insert");
      return { created: false, planId: existing };
    },

    async findPlanByKey(idempotencyKey) {
      const row = await one<{ planId: string }>(
        'SELECT plan_id AS "planId" FROM app.meals_plans WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      return row?.planId ?? null;
    },

    getPlan(planId) {
      return one<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM app.meals_plans WHERE plan_id = $1`, [
        planId
      ]);
    },

    async findPlanByDate(date) {
      const row = await one<{ planId: string }>(
        'SELECT d.plan_id AS "planId" FROM app.meals_plan_days d ' +
          "JOIN app.meals_plans p ON p.plan_id = d.plan_id " +
          "WHERE d.day_date = $1::date ORDER BY p.created_at DESC, p.plan_id LIMIT 1",
        [date]
      );
      return row?.planId ?? null;
    },

    async findCurrentPlan(date) {
      const row = await one<{ planId: string }>(
        'SELECT p.plan_id AS "planId" FROM app.meals_plans p ' +
          "ORDER BY (p.start_date <= $1::date AND p.start_date + p.day_count > $1::date) DESC, " +
          "(p.start_date > $1::date) DESC, " +
          "CASE WHEN p.start_date > $1::date THEN p.start_date END ASC, " +
          "p.created_at DESC, p.plan_id LIMIT 1",
        [date]
      );
      return row?.planId ?? null;
    },

    async setPlanState(planId, state: PlanState, pausedReason) {
      await db.query(
        "UPDATE app.meals_plans SET state = $2, paused_reason = $3, updated_at = now() " +
          "WHERE plan_id = $1",
        [planId, state, pausedReason]
      );
    },

    // Recipes outlive the plan. Planned meals point at them without a cascade, so a later
    // favourite keeps its recipe.
    async deletePlan(planId) {
      const { rows } = await db.query(
        "DELETE FROM app.meals_plans WHERE plan_id = $1 RETURNING plan_id",
        [planId]
      );
      return rows.length > 0;
    },

    async listDays(planId) {
      const { rows } = await db.query<DayRow>(
        `SELECT ${DAY_COLUMNS} FROM app.meals_plan_days WHERE plan_id = $1 ORDER BY day_date`,
        [planId]
      );
      return rows;
    },

    getDay(dayId) {
      return one<DayRow>(`SELECT ${DAY_COLUMNS} FROM app.meals_plan_days WHERE day_id = $1`, [
        dayId
      ]);
    },

    async bumpDay(dayId) {
      const row = await one<{ generation: number }>(
        "WITH d AS (UPDATE app.meals_plan_days SET generation = generation + 1, " +
          "status = 'pending', failure_reason = NULL, updated_at = now() " +
          "WHERE day_id = $1 RETURNING generation), " +
          "m AS (UPDATE app.meals_planned_meals SET status = 'pending', failure_reason = NULL, " +
          "updated_at = now() WHERE day_id = $1 AND status IN ('failed', 'writing') " +
          "AND EXISTS (SELECT 1 FROM d) RETURNING 1) " +
          "SELECT generation FROM d",
        [dayId]
      );
      return row?.generation ?? null;
    },

    async claimDay(dayId, generation) {
      const { rows } = await db.query(
        "UPDATE app.meals_plan_days d SET status = 'writing', updated_at = now() " +
          "WHERE d.day_id = $1 AND d.generation = $2 AND d.status <> 'ready' " +
          "AND NOT EXISTS (SELECT 1 FROM app.meals_plan_days o WHERE o.plan_id = d.plan_id " +
          "AND o.day_id <> d.day_id AND o.status = 'writing' " +
          `AND o.updated_at > now() - interval '${WRITING_LEASE_SECONDS} seconds') ` +
          "RETURNING d.day_id",
        [dayId, generation]
      );
      return rows.length > 0;
    },

    async finishDay(dayId, generation, status: WriteStatus, failureReason) {
      const { rows } = await db.query(
        "UPDATE app.meals_plan_days SET status = $3, failure_reason = $4, updated_at = now() " +
          "WHERE day_id = $1 AND generation = $2 RETURNING day_id",
        [dayId, generation, status, failureReason]
      );
      return rows.length > 0;
    },

    async listMeals(planId) {
      const { rows } = await db.query<MealRow>(
        `SELECT ${MEAL_COLUMNS} FROM app.meals_planned_meals m ` +
          "JOIN app.meals_plan_days d ON d.day_id = m.day_id WHERE d.plan_id = $1 " +
          "ORDER BY d.day_date, m.slot_position",
        [planId]
      );
      return rows;
    },

    async listDayMeals(dayId) {
      const { rows } = await db.query<MealRow>(
        `SELECT ${MEAL_COLUMNS} FROM app.meals_planned_meals m WHERE m.day_id = $1 ` +
          "ORDER BY m.slot_position",
        [dayId]
      );
      return rows;
    },

    getMeal(mealId) {
      return one<MealRow & { planId: string; date: string }>(
        `SELECT ${MEAL_COLUMNS}, d.plan_id AS "planId", d.day_date::text AS date ` +
          "FROM app.meals_planned_meals m JOIN app.meals_plan_days d ON d.day_id = m.day_id " +
          "WHERE m.meal_id = $1",
        [mealId]
      );
    },

    async claimMeal(mealId, dayId, generation) {
      const { rows } = await db.query(
        "UPDATE app.meals_planned_meals m SET status = 'writing', generation = $3, " +
          "failure_reason = NULL, updated_at = now() " +
          "FROM app.meals_plan_days d JOIN app.meals_plans p ON p.plan_id = d.plan_id " +
          "WHERE m.meal_id = $1 AND m.day_id = $2 AND d.day_id = m.day_id " +
          "AND d.generation = $3 AND p.state = 'active' AND m.status <> 'ready' AND NOT m.locked " +
          "RETURNING m.meal_id",
        [mealId, dayId, generation]
      );
      return rows.length > 0;
    },

    async saveMealReady(input) {
      const { recipe } = input;
      const ingredients = recipe.ingredients.map((line, position) => ({
        position,
        original_text: line.originalText,
        name: line.name,
        name_key: nameKey(line.name),
        quantity: line.quantity,
        unit: line.unit,
        store_section: line.section,
        check_label: line.checkLabel
      }));
      const eaters = input.eaters.map((eater) => ({
        member_id: eater.memberId,
        portion: eater.portion,
        estimated_kcal: eater.estimatedKcal,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ saved: boolean }>(
        "WITH m AS (UPDATE app.meals_planned_meals SET status = 'ready', failure_reason = NULL, " +
          "recipe_id = $3, attempts = $4, updated_at = now() " +
          "WHERE meal_id = $1 AND generation = $2 AND status = 'writing' RETURNING meal_id), " +
          "r AS (INSERT INTO app.meals_recipes (owner_user_id, kitchen_id, recipe_id, title, " +
          "title_key, steps, cook_minutes, base_servings, kcal_per_serving, source) " +
          "SELECT app.current_actor_user_id(), $5, $3, $6, $7, $8::jsonb, $9, $10, $11, " +
          "'generated' FROM m RETURNING 1), " +
          "i AS (INSERT INTO app.meals_recipe_ingredients (owner_user_id, kitchen_id, recipe_id, " +
          "position, original_text, name, name_key, quantity, unit, store_section, check_label) " +
          "SELECT app.current_actor_user_id(), $5, $3, x.position, x.original_text, x.name, " +
          "x.name_key, x.quantity, x.unit, x.store_section, x.check_label FROM m, " +
          "jsonb_to_recordset($12::jsonb) AS x(position smallint, original_text text, name text, " +
          "name_key text, quantity numeric, unit text, store_section text, check_label boolean) " +
          "RETURNING 1), " +
          "e AS (UPDATE app.meals_planned_meal_eaters t SET portion = x.portion, " +
          "estimated_kcal = x.estimated_kcal, safety = x.safety, safety_reason = x.safety_reason, " +
          "updated_at = now() FROM m, jsonb_to_recordset($13::jsonb) AS x(member_id uuid, " +
          "portion numeric, estimated_kcal integer, safety text, safety_reason text) " +
          "WHERE t.meal_id = m.meal_id AND t.member_id = x.member_id RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS saved",
        [
          input.mealId,
          input.generation,
          recipe.recipeId,
          input.attempts,
          input.kitchenId,
          recipe.title,
          recipe.titleKey,
          JSON.stringify(recipe.steps),
          recipe.cookMinutes,
          recipe.baseServings,
          recipe.kcalPerServing,
          JSON.stringify(ingredients),
          JSON.stringify(eaters)
        ]
      );
      return row?.saved === true;
    },

    async failMeal(mealId, generation, failureReason: GenerationFailure, attempts, eaters) {
      const verdicts = (eaters ?? []).map((eater: MealEaterRow) => ({
        member_id: eater.memberId,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ failed: boolean }>(
        "WITH m AS (UPDATE app.meals_planned_meals SET status = 'failed', failure_reason = $3, " +
          "attempts = $4, updated_at = now() " +
          "WHERE meal_id = $1 AND generation = $2 AND status = 'writing' RETURNING meal_id), " +
          "e AS (UPDATE app.meals_planned_meal_eaters t SET safety = x.safety, " +
          "safety_reason = x.safety_reason, updated_at = now() FROM m, " +
          "jsonb_to_recordset($5::jsonb) AS x(member_id uuid, safety text, safety_reason text) " +
          "WHERE t.meal_id = m.meal_id AND t.member_id = x.member_id RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS failed",
        [mealId, generation, failureReason, attempts, JSON.stringify(verdicts)]
      );
      return row?.failed === true;
    },

    async setMealLocked(mealId, locked) {
      const { rows } = await db.query(
        "UPDATE app.meals_planned_meals SET locked = $2, updated_at = now() " +
          "WHERE meal_id = $1 AND kind = 'recipe' AND cooked_at IS NULL RETURNING meal_id",
        [mealId, locked]
      );
      return rows.length > 0;
    },

    async moveMeal(input) {
      const { rows } = await db.query(
        "UPDATE app.meals_planned_meals SET day_id = $2, slot_name = $3, slot_position = $4, " +
          "updated_at = now() WHERE meal_id = $1 AND cooked_at IS NULL AND status <> 'writing' " +
          "RETURNING meal_id",
        [input.mealId, input.dayId, input.slotName, input.slotPosition]
      );
      return rows.length > 0;
    },

    async setMealEaters(input) {
      const eaters = input.eaters.map((eater) => ({
        member_id: eater.memberId,
        portion: eater.portion,
        estimated_kcal: eater.estimatedKcal,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ saved: boolean }>(
        "WITH m AS (UPDATE app.meals_planned_meals SET servings_override = NULL, " +
          "updated_at = now() WHERE meal_id = $1 AND kind = 'recipe' AND cooked_at IS NULL " +
          "AND status IN ('ready', 'failed') RETURNING meal_id), " +
          "d AS (DELETE FROM app.meals_planned_meal_eaters WHERE meal_id IN " +
          "(SELECT meal_id FROM m) RETURNING 1), " +
          "e AS (INSERT INTO app.meals_planned_meal_eaters (owner_user_id, kitchen_id, meal_id, " +
          "member_id, portion, estimated_kcal, safety, safety_reason) " +
          "SELECT app.current_actor_user_id(), meal.kitchen_id, meal.meal_id, x.member_id, " +
          "x.portion, x.estimated_kcal, x.safety, x.safety_reason FROM m " +
          "JOIN app.meals_planned_meals meal ON meal.meal_id = m.meal_id, " +
          "jsonb_to_recordset($2::jsonb) AS x(member_id uuid, portion numeric, " +
          "estimated_kcal integer, safety text, safety_reason text) RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS saved",
        [input.mealId, JSON.stringify(eaters)]
      );
      return row?.saved === true;
    },

    async setMealText(mealId, text) {
      const { rows } = await db.query(
        "UPDATE app.meals_planned_meals SET kind = 'text', plain_text = $2, recipe_id = NULL, " +
          "locked = false, servings_override = NULL, status = 'ready', failure_reason = NULL, " +
          "updated_at = now() WHERE meal_id = $1 AND cooked_at IS NULL AND status <> 'writing' " +
          "RETURNING meal_id",
        [mealId, text]
      );
      return rows.length > 0;
    },

    async clearMealText(mealId) {
      const { rows } = await db.query(
        "UPDATE app.meals_planned_meals SET kind = 'recipe', plain_text = NULL, " +
          "status = 'pending', failure_reason = NULL, updated_at = now() " +
          "WHERE meal_id = $1 AND kind = 'text' AND cooked_at IS NULL RETURNING meal_id",
        [mealId]
      );
      return rows.length > 0;
    },

    async addOneOffMeal(input) {
      const row = await one<{ added: boolean }>(
        "WITH m AS (INSERT INTO app.meals_planned_meals (owner_user_id, kitchen_id, day_id, " +
          "meal_id, slot_name, slot_position, kind, sharing, status, one_off_for) " +
          "SELECT app.current_actor_user_id(), $2, $3, $1, $4, $5, 'recipe', 'solo', " +
          "'pending', $6 RETURNING meal_id), " +
          "e AS (INSERT INTO app.meals_planned_meal_eaters (owner_user_id, kitchen_id, meal_id, " +
          "member_id) SELECT app.current_actor_user_id(), $2, meal_id, $6 FROM m RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS added",
        [
          input.mealId,
          input.kitchenId,
          input.dayId,
          input.slotName,
          input.slotPosition,
          input.memberId
        ]
      );
      return row?.added === true;
    },

    async setDayCookLimit(dayId, minutes) {
      const { rows } = await db.query(
        "UPDATE app.meals_plan_days SET cook_time_limit_minutes = $2, updated_at = now() " +
          "WHERE day_id = $1 RETURNING day_id",
        [dayId, minutes]
      );
      return rows.length > 0;
    },

    async setDaySharing(dayId, slotName, sharing) {
      const { rows } = await db.query(
        "UPDATE app.meals_plan_days SET sharing_overrides = jsonb_set(sharing_overrides, $2, " +
          "$3::jsonb), updated_at = now() WHERE day_id = $1 RETURNING day_id",
        [dayId, [slotName], JSON.stringify(sharing)]
      );
      return rows.length > 0;
    },

    async splitMeal(input) {
      const copies = input.copies.map((copy) => ({
        meal_id: copy.mealId,
        member_id: copy.memberId
      }));
      const row = await one<{ split: boolean }>(
        "WITH src AS (SELECT * FROM app.meals_planned_meals WHERE meal_id = $1 " +
          "AND sharing = 'shared' AND cooked_at IS NULL AND status <> 'writing'), " +
          "kept AS (DELETE FROM app.meals_planned_meal_eaters WHERE meal_id IN " +
          "(SELECT meal_id FROM src) AND member_id <> (SELECT member_id FROM " +
          "app.meals_planned_meal_eaters WHERE meal_id = $1 ORDER BY created_at, member_id " +
          "LIMIT 1) RETURNING 1), " +
          "own AS (UPDATE app.meals_planned_meals SET sharing = 'solo', servings_override = NULL, updated_at = now() " +
          "WHERE meal_id IN (SELECT meal_id FROM src) RETURNING meal_id), " +
          "copy AS (INSERT INTO app.meals_planned_meals (owner_user_id, kitchen_id, day_id, " +
          "meal_id, slot_name, slot_position, kind, sharing, status, failure_reason, locked, " +
          "one_off_for, favourite_of, servings_override, recipe_id, plain_text, attempts, " +
          "generation, job_generation) SELECT s.owner_user_id, s.kitchen_id, s.day_id, " +
          "x.meal_id, s.slot_name, s.slot_position, s.kind, 'solo', s.status, " +
          "s.failure_reason, s.locked, s.one_off_for, s.favourite_of, NULL, s.recipe_id, " +
          "s.plain_text, s.attempts, s.generation, 0 FROM src s, " +
          "jsonb_to_recordset($2::jsonb) AS x(meal_id uuid, member_id uuid) RETURNING meal_id), " +
          "e AS (INSERT INTO app.meals_planned_meal_eaters (owner_user_id, kitchen_id, meal_id, " +
          "member_id, portion, estimated_kcal, safety, safety_reason) " +
          "SELECT s.owner_user_id, s.kitchen_id, x.meal_id, x.member_id, eater.portion, " +
          "eater.estimated_kcal, eater.safety, eater.safety_reason FROM src s, " +
          "jsonb_to_recordset($2::jsonb) AS x(meal_id uuid, member_id uuid) " +
          "JOIN app.meals_planned_meal_eaters eater ON eater.meal_id = s.meal_id " +
          "AND eater.member_id = x.member_id RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM own) AS split",
        [input.mealId, JSON.stringify(copies)]
      );
      return row?.split === true;
    },

    async mergeSlotMeals(input) {
      const eaters = input.eaters.map((eater) => ({
        member_id: eater.memberId,
        portion: eater.portion,
        estimated_kcal: eater.estimatedKcal,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ merged: boolean }>(
        "WITH slot AS (SELECT meal_id FROM app.meals_planned_meals WHERE day_id = $1 " +
          "AND slot_name = $2), " +
          "guard AS (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM app.meals_planned_meals " +
          "WHERE day_id = $1 AND slot_name = $2 AND (cooked_at IS NOT NULL " +
          "OR status = 'writing')) AND EXISTS (SELECT 1 FROM slot)), " +
          "kept AS (UPDATE app.meals_planned_meals SET sharing = 'shared', " +
          "servings_override = NULL, updated_at = now() WHERE meal_id = $3 " +
          "AND EXISTS (SELECT 1 FROM guard) RETURNING meal_id), " +
          "d AS (DELETE FROM app.meals_planned_meal_eaters WHERE meal_id IN " +
          "(SELECT meal_id FROM kept) RETURNING 1), " +
          "e AS (INSERT INTO app.meals_planned_meal_eaters (owner_user_id, kitchen_id, meal_id, " +
          "member_id, portion, estimated_kcal, safety, safety_reason) " +
          "SELECT app.current_actor_user_id(), meal.kitchen_id, meal.meal_id, x.member_id, " +
          "x.portion, x.estimated_kcal, x.safety, x.safety_reason FROM kept " +
          "JOIN app.meals_planned_meals meal ON meal.meal_id = kept.meal_id, " +
          "jsonb_to_recordset($4::jsonb) AS x(member_id uuid, portion numeric, " +
          "estimated_kcal integer, safety text, safety_reason text) RETURNING 1), " +
          "gone AS (DELETE FROM app.meals_planned_meals WHERE day_id = $1 AND slot_name = $2 " +
          "AND meal_id <> $3 AND EXISTS (SELECT 1 FROM kept) RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM kept) AS merged",
        [input.dayId, input.slotName, input.keepMealId, JSON.stringify(eaters)]
      );
      return row?.merged === true;
    },

    async resetMeals(mealIds) {
      if (mealIds.length === 0) return 0;
      const row = await one<{ count: number }>(
        "WITH m AS (UPDATE app.meals_planned_meals SET status = 'pending', failure_reason = NULL, " +
          "attempts = 0, updated_at = now() WHERE meal_id = ANY($1::uuid[]) AND kind = 'recipe' " +
          "AND NOT locked AND cooked_at IS NULL AND status IN ('ready', 'failed') " +
          "RETURNING meal_id), " +
          "c AS (DELETE FROM app.meals_swap_choices WHERE meal_id IN (SELECT meal_id FROM m) " +
          "RETURNING 1) " +
          "SELECT count(*)::int AS count FROM m",
        [[...mealIds]]
      );
      return row?.count ?? 0;
    },

    async startMealJob(mealId) {
      const row = await one<{ generation: number }>(
        "UPDATE app.meals_planned_meals SET job_generation = job_generation + 1, " +
          "updated_at = now() WHERE meal_id = $1 RETURNING job_generation AS generation",
        [mealId]
      );
      return row?.generation ?? null;
    },

    async replaceSwapChoices(mealId, kitchenId, generation, choices) {
      const rows = choices.map((choice) => ({
        choice_id: choice.choiceId,
        position: choice.position
      }));
      await db.query(
        "WITH d AS (DELETE FROM app.meals_swap_choices WHERE meal_id = $1 RETURNING 1) " +
          "INSERT INTO app.meals_swap_choices (owner_user_id, kitchen_id, meal_id, choice_id, " +
          "position, generation) SELECT app.current_actor_user_id(), $2, $1, x.choice_id, " +
          "x.position, $3 FROM jsonb_to_recordset($4::jsonb) AS x(choice_id uuid, " +
          "position smallint) WHERE EXISTS (SELECT 1 FROM app.meals_planned_meals " +
          "WHERE meal_id = $1)",
        [mealId, kitchenId, generation, JSON.stringify(rows)]
      );
    },

    async listSwapChoices(mealId) {
      const { rows } = await db.query<SwapChoiceRow>(
        'SELECT choice_id AS "choiceId", position, status, recipe_id AS "recipeId", generation ' +
          "FROM app.meals_swap_choices WHERE meal_id = $1 ORDER BY position",
        [mealId]
      );
      return rows;
    },

    async claimSwapChoice(choiceId, generation) {
      const { rows } = await db.query(
        "UPDATE app.meals_swap_choices SET status = 'writing', updated_at = now() " +
          "WHERE choice_id = $1 AND generation = $2 AND status = 'pending' RETURNING choice_id",
        [choiceId, generation]
      );
      return rows.length > 0;
    },

    async saveChoiceReady(input) {
      const { recipe } = input;
      const ingredients = recipe.ingredients.map((line, position) => ({
        position,
        original_text: line.originalText,
        name: line.name,
        name_key: nameKey(line.name),
        quantity: line.quantity,
        unit: line.unit,
        store_section: line.section,
        check_label: line.checkLabel
      }));
      const row = await one<{ saved: boolean }>(
        "WITH c AS (UPDATE app.meals_swap_choices SET status = 'ready', recipe_id = $3, " +
          "updated_at = now() WHERE choice_id = $1 AND generation = $2 AND status = 'writing' " +
          "RETURNING choice_id), " +
          "r AS (INSERT INTO app.meals_recipes (owner_user_id, kitchen_id, recipe_id, title, " +
          "title_key, steps, cook_minutes, base_servings, kcal_per_serving, source) " +
          "SELECT app.current_actor_user_id(), $4, $3, $5, $6, $7::jsonb, $8, $9, $10, " +
          "'generated' FROM c RETURNING 1), " +
          "i AS (INSERT INTO app.meals_recipe_ingredients (owner_user_id, kitchen_id, recipe_id, " +
          "position, original_text, name, name_key, quantity, unit, store_section, check_label) " +
          "SELECT app.current_actor_user_id(), $4, $3, x.position, x.original_text, x.name, " +
          "x.name_key, x.quantity, x.unit, x.store_section, x.check_label FROM c, " +
          "jsonb_to_recordset($11::jsonb) AS x(position smallint, original_text text, name text, " +
          "name_key text, quantity numeric, unit text, store_section text, check_label boolean) " +
          "RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM c) AS saved",
        [
          input.choiceId,
          input.generation,
          recipe.recipeId,
          input.kitchenId,
          recipe.title,
          recipe.titleKey,
          JSON.stringify(recipe.steps),
          recipe.cookMinutes,
          recipe.baseServings,
          recipe.kcalPerServing,
          JSON.stringify(ingredients)
        ]
      );
      return row?.saved === true;
    },

    async failChoice(choiceId, generation) {
      const { rows } = await db.query(
        "UPDATE app.meals_swap_choices SET status = 'failed', updated_at = now() " +
          "WHERE choice_id = $1 AND generation = $2 AND status IN ('pending', 'writing') " +
          "RETURNING choice_id",
        [choiceId, generation]
      );
      return rows.length > 0;
    },

    async chooseSwap(input) {
      const eaters = input.eaters.map((eater) => ({
        member_id: eater.memberId,
        portion: eater.portion,
        estimated_kcal: eater.estimatedKcal,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ chosen: boolean }>(
        "WITH c AS (SELECT recipe_id FROM app.meals_swap_choices WHERE choice_id = $2 " +
          "AND meal_id = $1 AND status = 'ready' AND recipe_id IS NOT NULL), " +
          "m AS (UPDATE app.meals_planned_meals SET recipe_id = (SELECT recipe_id FROM c), " +
          "status = 'ready', failure_reason = NULL, attempts = 0, updated_at = now() " +
          "WHERE meal_id = $1 AND kind = 'recipe' AND cooked_at IS NULL " +
          "AND status IN ('ready', 'failed') AND EXISTS (SELECT 1 FROM c) RETURNING meal_id), " +
          "e AS (UPDATE app.meals_planned_meal_eaters t SET portion = x.portion, " +
          "estimated_kcal = x.estimated_kcal, safety = x.safety, safety_reason = x.safety_reason, " +
          "updated_at = now() FROM m, jsonb_to_recordset($3::jsonb) AS x(member_id uuid, " +
          "portion numeric, estimated_kcal integer, safety text, safety_reason text) " +
          "WHERE t.meal_id = m.meal_id AND t.member_id = x.member_id RETURNING 1), " +
          "d AS (DELETE FROM app.meals_swap_choices WHERE meal_id IN (SELECT meal_id FROM m) " +
          "RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS chosen",
        [input.mealId, input.choiceId, JSON.stringify(eaters)]
      );
      return row?.chosen === true;
    },

    async saveEaterVerdicts(input) {
      const verdicts = input.eaters.map((eater) => ({
        member_id: eater.memberId,
        safety: eater.safety,
        safety_reason: eater.safetyReason
      }));
      const row = await one<{ saved: boolean }>(
        "WITH m AS (SELECT meal_id FROM app.meals_planned_meals " +
          "WHERE meal_id = $1 AND job_generation = $2 AND recipe_id = $3), " +
          "u AS (UPDATE app.meals_planned_meal_eaters t SET safety = x.safety, " +
          "safety_reason = x.safety_reason, updated_at = now() " +
          "FROM m, jsonb_to_recordset($4::jsonb) AS x(member_id uuid, safety text, safety_reason text) " +
          "WHERE t.meal_id = m.meal_id AND t.member_id = x.member_id RETURNING 1) " +
          "SELECT EXISTS (SELECT 1 FROM m) AS saved",
        [input.mealId, input.generation, input.recipeId, JSON.stringify(verdicts)]
      );
      return row?.saved === true;
    },

    async getRecipes(recipeIds) {
      if (recipeIds.length === 0) return [];
      const { rows } = await db.query<RecipeRow>(
        'SELECT r.recipe_id AS "recipeId", r.title, r.title_key AS "titleKey", r.steps, ' +
          'r.cook_minutes AS "cookMinutes", r.base_servings::float8 AS "baseServings", ' +
          'r.kcal_per_serving AS "kcalPerServing", ' +
          "coalesce((SELECT jsonb_agg(jsonb_build_object('originalText', i.original_text, " +
          "'name', i.name, 'quantity', i.quantity::float8, 'unit', i.unit, " +
          "'section', i.store_section, 'checkLabel', i.check_label) ORDER BY i.position) " +
          "FROM app.meals_recipe_ingredients i WHERE i.recipe_id = r.recipe_id), '[]'::jsonb) " +
          "AS ingredients FROM app.meals_recipes r WHERE r.recipe_id = ANY($1::uuid[])",
        [[...recipeIds]]
      );
      return rows;
    },

    async recentTitles(kitchenId, from, to) {
      const { rows } = await db.query<{ title: string; titleKey: string }>(
        'SELECT r.title, r.title_key AS "titleKey" FROM app.meals_planned_meals m ' +
          "JOIN app.meals_plan_days d ON d.day_id = m.day_id " +
          "JOIN app.meals_recipes r ON r.recipe_id = m.recipe_id " +
          "WHERE m.kitchen_id = $1 AND m.status = 'ready' " +
          "AND d.day_date BETWEEN $2::date AND $3::date ORDER BY d.day_date, m.slot_position",
        [kitchenId, from, to]
      );
      return rows;
    }
  };
}
