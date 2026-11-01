// external-modules/meals/src/store/pantry.ts
//
// The Pantry and Staples over SQL. Every query runs under the module runtime role with RLS scoped
// to the acting owner, so a query names the owner only through app.current_actor_user_id() on
// insert. ctx.db has no transactions, so a remove and its Undo record are one statement.
import type { PantryItemView, StapleView } from "../contracts.js";
import type { PantryStore } from "./pantry-port.js";
import type { MealsDb } from "./sql.js";

const ITEMS = "app.meals_pantry_items";
const STAPLES = "app.meals_staples";

interface ItemRow {
  item_id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  source: PantryItemView["source"];
  updated_at: string;
}

const ITEM_COLUMNS =
  "item_id, name, quantity::float8 AS quantity, unit, source, " +
  "to_json(updated_at) #>> '{}' AS updated_at";

const toItem = (row: ItemRow): PantryItemView => ({
  itemId: row.item_id,
  name: row.name,
  quantity: row.quantity,
  unit: row.unit,
  source: row.source,
  updatedAt: row.updated_at
});

const toStaple = (row: { staple_id: string; name: string }): StapleView => ({
  stapleId: row.staple_id,
  name: row.name
});

export function sqlPantryStore(db: MealsDb): PantryStore {
  return {
    async readItems() {
      const { rows } = await db.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM ${ITEMS} ORDER BY name_key, created_at, item_id`
      );
      return rows.map(toItem);
    },

    async readStaples() {
      const { rows } = await db.query<{ staple_id: string; name: string }>(
        `SELECT staple_id, name FROM ${STAPLES} ORDER BY name_key`
      );
      return rows.map(toStaple);
    },

    async addItem(kitchenId, item) {
      await db.query(
        `INSERT INTO ${ITEMS} (owner_user_id, kitchen_id, item_id, name, name_key, quantity, ` +
          "unit, source) VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, 'manual')",
        [kitchenId, item.itemId, item.name, item.nameKey, item.quantity, item.unit]
      );
    },

    async updateItem(itemId, patch) {
      const sets: string[] = [];
      const params: unknown[] = [itemId];
      const set = (column: string, cast: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}::${cast}`);
      };
      if (patch.name !== undefined) set("name", "text", patch.name);
      if (patch.nameKey !== undefined) set("name_key", "text", patch.nameKey);
      if (patch.quantity !== undefined) set("quantity", "numeric", patch.quantity);
      if (patch.unit !== undefined) set("unit", "text", patch.unit);
      const { rows } = await db.query<ItemRow>(
        `UPDATE ${ITEMS} SET ${[...sets, "updated_at = now()"].join(", ")} ` +
          `WHERE item_id = $1 RETURNING ${ITEM_COLUMNS}`,
        params
      );
      return rows[0] ? toItem(rows[0]) : null;
    },

    async removeItem(itemId, undo) {
      const { rows } = await db.query<{ removed: number }>(
        `WITH gone AS (DELETE FROM ${ITEMS} WHERE item_id = $1 ` +
          "RETURNING item_id, name, name_key, quantity::float8 AS quantity, unit, source, " +
          "to_json(created_at) #>> '{}' AS created_at), " +
          "saved AS (INSERT INTO app.meals_undo_actions " +
          "(owner_user_id, kitchen_id, action_id, kind, before_state) " +
          "SELECT app.current_actor_user_id(), $2, $3, 'removed', " +
          "jsonb_build_object('item', to_jsonb(g)) FROM gone g) " +
          "SELECT count(*)::int AS removed FROM gone",
        [itemId, undo.kitchenId, undo.actionId]
      );
      return (rows[0]?.removed ?? 0) > 0;
    },

    async undoRemoved(actionId, kitchenId, record) {
      const { rows } = await db.query<{ restored: number }>(
        "WITH mark AS (UPDATE app.meals_undo_actions SET undone_at = now() " +
          "WHERE action_id = $1 AND undone_at IS NULL RETURNING action_id), " +
          `back AS (INSERT INTO ${ITEMS} (owner_user_id, kitchen_id, item_id, name, name_key, ` +
          "quantity, unit, source, created_at) " +
          "SELECT app.current_actor_user_id(), $2, x.item_id, x.name, x.name_key, x.quantity, " +
          "x.unit, x.source, x.created_at FROM jsonb_to_recordset($3::jsonb) AS x(item_id uuid, " +
          "name text, name_key text, quantity numeric, unit text, source text, " +
          "created_at timestamptz) WHERE EXISTS (SELECT 1 FROM mark) " +
          "ON CONFLICT DO NOTHING RETURNING item_id) " +
          "SELECT count(*)::int AS restored FROM back",
        [actionId, kitchenId, JSON.stringify([record])]
      );
      return rows[0]?.restored ?? 0;
    },

    async addStaple(kitchenId, staple) {
      const { rows } = await db.query(
        `INSERT INTO ${STAPLES} (owner_user_id, kitchen_id, staple_id, name, name_key) ` +
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4) ON CONFLICT DO NOTHING " +
          "RETURNING staple_id",
        [kitchenId, staple.stapleId, staple.name, staple.nameKey]
      );
      return rows.length > 0;
    },

    async renameStaple(stapleId, name, nameKey) {
      const { rows } = await db.query<{ staple_id: string; name: string }>(
        `UPDATE ${STAPLES} s SET name = $2, name_key = $3 WHERE s.staple_id = $1 ` +
          `AND NOT EXISTS (SELECT 1 FROM ${STAPLES} o WHERE o.name_key = $3 AND o.staple_id <> $1) ` +
          "RETURNING staple_id, name",
        [stapleId, name, nameKey]
      );
      if (rows[0]) return toStaple(rows[0]);
      const { rows: found } = await db.query(`SELECT 1 FROM ${STAPLES} WHERE staple_id = $1`, [
        stapleId
      ]);
      return found.length > 0 ? "taken" : null;
    },

    async removeStaple(stapleId) {
      const { rows } = await db.query(`DELETE FROM ${STAPLES} WHERE staple_id = $1 RETURNING 1`, [
        stapleId
      ]);
      return rows.length > 0;
    }
  };
}
