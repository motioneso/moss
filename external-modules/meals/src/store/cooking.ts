// external-modules/meals/src/store/cooking.ts
//
// Cooking, ratings and favourites over SQL. Every query runs under the module runtime role with
// RLS scoped to the acting owner. ctx.db has no transactions, so Mark cooked, its Pantry changes
// and its Undo record are one statement.
import { markKey, type CookingStore } from "./cooking-port.js";
import type { MealsDb } from "./sql.js";

const MEALS = "app.meals_planned_meals";
const PANTRY = "app.meals_pantry_items";

export function sqlCookingStore(db: MealsDb): CookingStore {
  return {
    async readMarks() {
      const [ratings, favourites] = await Promise.all([
        db.query<{ member_id: string; recipe_id: string; stars: number }>(
          "SELECT member_id, recipe_id, stars FROM app.meals_ratings"
        ),
        db.query<{ member_id: string; recipe_id: string }>(
          "SELECT member_id, recipe_id FROM app.meals_favourites"
        )
      ]);
      return {
        ratings: new Map(ratings.rows.map((r) => [markKey(r.member_id, r.recipe_id), r.stars])),
        favourites: new Set(favourites.rows.map((r) => markKey(r.member_id, r.recipe_id)))
      };
    },

    async markCooked({ actionId, kitchenId, state }) {
      const changes = state.changes.map((c) => ({
        item_id: c.itemId,
        before: c.before,
        after: c.after
      }));
      const { rows } = await db.query<{ marked: number }>(
        `WITH mark AS (UPDATE ${MEALS} SET cooked_at = $2::timestamptz, updated_at = now() ` +
          "WHERE meal_id = $1 AND cooked_at IS NULL AND status = 'ready' RETURNING meal_id), " +
          `stock AS (UPDATE ${PANTRY} p SET quantity = x.after, updated_at = $2::timestamptz ` +
          "FROM jsonb_to_recordset($3::jsonb) AS x(item_id uuid, before numeric, after numeric) " +
          "WHERE p.item_id = x.item_id AND EXISTS (SELECT 1 FROM mark) RETURNING p.item_id), " +
          "record AS (INSERT INTO app.meals_undo_actions (owner_user_id, kitchen_id, action_id, " +
          "kind, before_state) SELECT app.current_actor_user_id(), $4, $5, 'cooked', $6::jsonb " +
          "WHERE EXISTS (SELECT 1 FROM mark) RETURNING action_id) " +
          "SELECT (SELECT count(*) FROM mark)::int AS marked",
        [
          state.mealId,
          state.at,
          JSON.stringify(changes),
          kitchenId,
          actionId,
          JSON.stringify({ mealId: state.mealId, at: state.at, changes: state.changes })
        ]
      );
      return (rows[0]?.marked ?? 0) > 0;
    },

    async undoCooked(actionId, state) {
      const changes = state.changes.map((c) => ({
        item_id: c.itemId,
        before: c.before,
        after: c.after
      }));
      const { rows } = await db.query<{ restored: number }>(
        "WITH mark AS (UPDATE app.meals_undo_actions SET undone_at = now() " +
          "WHERE action_id = $1 AND undone_at IS NULL RETURNING action_id), " +
          `uncooked AS (UPDATE ${MEALS} SET cooked_at = NULL, updated_at = now() ` +
          "WHERE meal_id = $2 AND cooked_at = $3::timestamptz AND EXISTS (SELECT 1 FROM mark) " +
          "RETURNING meal_id), " +
          `back AS (UPDATE ${PANTRY} p SET quantity = x.before, updated_at = now() ` +
          "FROM jsonb_to_recordset($4::jsonb) AS x(item_id uuid, before numeric, after numeric) " +
          "WHERE p.item_id = x.item_id AND p.updated_at = $3::timestamptz " +
          "AND EXISTS (SELECT 1 FROM mark) RETURNING p.item_id) " +
          "SELECT (SELECT count(*) FROM back)::int AS restored",
        [actionId, state.mealId, state.at, JSON.stringify(changes)]
      );
      return rows[0]?.restored ?? 0;
    },

    async setServings(mealId, servings) {
      const { rows } = await db.query(
        `UPDATE ${MEALS} SET servings_override = $2, updated_at = now() ` +
          "WHERE meal_id = $1 RETURNING meal_id",
        [mealId, servings]
      );
      return rows.length > 0;
    },

    async setRating(kitchenId, memberId, recipeId, stars) {
      if (stars === null) {
        await db.query("DELETE FROM app.meals_ratings WHERE member_id = $1 AND recipe_id = $2", [
          memberId,
          recipeId
        ]);
        return;
      }
      await db.query(
        "INSERT INTO app.meals_ratings (owner_user_id, kitchen_id, member_id, recipe_id, stars) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4) " +
          "ON CONFLICT (owner_user_id, member_id, recipe_id) " +
          "DO UPDATE SET stars = EXCLUDED.stars, rated_at = now()",
        [kitchenId, memberId, recipeId, stars]
      );
    },

    async setFavourite(kitchenId, memberId, recipeId, on) {
      if (!on) {
        await db.query("DELETE FROM app.meals_favourites WHERE member_id = $1 AND recipe_id = $2", [
          memberId,
          recipeId
        ]);
        return;
      }
      await db.query(
        "INSERT INTO app.meals_favourites (owner_user_id, kitchen_id, member_id, recipe_id) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3) ON CONFLICT DO NOTHING",
        [kitchenId, memberId, recipeId]
      );
    },

    async vetoes(memberIds) {
      if (memberIds.length === 0) return [];
      const { rows } = await db.query<{ member_id: string; title: string; title_key: string }>(
        "SELECT r.member_id, c.title, c.title_key FROM app.meals_ratings r " +
          "JOIN app.meals_recipes c ON c.recipe_id = r.recipe_id " +
          "WHERE r.stars = 1 AND r.member_id = ANY($1::uuid[])",
        [[...memberIds]]
      );
      return rows.map((r) => ({ memberId: r.member_id, title: r.title, titleKey: r.title_key }));
    },

    async placeRecipe({ mealId, recipeId, favouriteOf, eaters }) {
      const verdicts = eaters.map((e) => ({
        member_id: e.memberId,
        safety: e.safety,
        reason: e.safetyReason,
        kcal: e.estimatedKcal
      }));
      const { rows } = await db.query<{ placed: number }>(
        `WITH m AS (UPDATE ${MEALS} SET recipe_id = $2, kind = 'recipe', status = 'ready', ` +
          "failure_reason = NULL, plain_text = NULL, favourite_of = $3, servings_override = NULL, " +
          "cooked_at = NULL, updated_at = now() WHERE meal_id = $1 AND NOT locked " +
          "RETURNING meal_id), " +
          "e AS (UPDATE app.meals_planned_meal_eaters e SET safety = x.safety, " +
          "safety_reason = x.reason, estimated_kcal = x.kcal, updated_at = now() " +
          "FROM jsonb_to_recordset($4::jsonb) AS x(member_id uuid, safety text, reason text, " +
          "kcal int) WHERE e.meal_id = $1 AND e.member_id = x.member_id " +
          "AND EXISTS (SELECT 1 FROM m) RETURNING e.member_id) " +
          "SELECT (SELECT count(*) FROM m)::int AS placed",
        [mealId, recipeId, favouriteOf, JSON.stringify(verdicts)]
      );
      return (rows[0]?.placed ?? 0) > 0;
    }
  };
}
