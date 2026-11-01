// external-modules/meals/src/store/list.ts
//
// The shopping list over SQL. Every query runs under the module runtime role with RLS scoped to
// the acting owner, so a query names the owner only through app.current_actor_user_id() on
// insert. ctx.db has no transactions, so each multi-row or multi-table write is one statement of
// data-modifying CTEs, and a read never writes: before the first write readList returns an empty
// list with the id the first write will store.
import type { StoreSection } from "../contracts.js";
import type { ListDiff, Purchase, StoredLine } from "../domain/list.js";
import type { MealsDb } from "./sql.js";
import type { LinePatch, ListStore, UndoRecord } from "./list-port.js";

const LIST_ID_SQL = "md5('meals.list:' || app.current_actor_user_id()::text)::uuid";
const ITEMS = "app.meals_shopping_list_items";

// Open lines stay for a day after Bought so Undo can find them, then a rebuild sweeps them.
const BOUGHT_KEEP = "interval '1 day'";

interface LineRow {
  line_id: string;
  line_key: string | null;
  manual: boolean;
  name: string;
  quantity: number | null;
  unit: string | null;
  purchase_quantity: number | null;
  purchase_unit: string | null;
  store_section: StoreSection;
  covered_by_pantry: boolean;
  not_in_plan: boolean;
  converted_from: string[];
  source_meal_ids: string[];
  checked_at: string | null;
  bought_at: string | null;
}

const LINE_COLUMNS =
  "line_id, line_key, manual, name, quantity::float8 AS quantity, unit, " +
  "purchase_quantity::float8 AS purchase_quantity, purchase_unit, store_section, " +
  "covered_by_pantry, not_in_plan, converted_from, source_meal_ids::text[] AS source_meal_ids, " +
  "to_json(checked_at) #>> '{}' AS checked_at, to_json(bought_at) #>> '{}' AS bought_at";

function toLine(row: LineRow): StoredLine {
  return {
    lineId: row.line_id,
    lineKey: row.line_key,
    manual: row.manual,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    purchase:
      row.purchase_quantity === null
        ? null
        : { quantity: row.purchase_quantity, unit: row.purchase_unit ?? "" },
    section: row.store_section,
    coveredByPantry: row.covered_by_pantry,
    notInPlan: row.not_in_plan,
    convertedFrom: row.converted_from,
    sourceMealIds: row.source_meal_ids,
    checkedAt: row.checked_at,
    boughtAt: row.bought_at
  };
}

const unitOrNull = (purchase: Purchase | null) => (purchase?.unit ? purchase.unit : null);

/** A stored line as the snake_case JSON record the insert statements read. */
function lineRecord(line: StoredLine) {
  return {
    line_id: line.lineId,
    line_key: line.lineKey,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    purchase_quantity: line.purchase?.quantity ?? null,
    purchase_unit: unitOrNull(line.purchase),
    store_section: line.section,
    manual: line.manual,
    covered_by_pantry: line.coveredByPantry,
    not_in_plan: line.notInPlan,
    converted_from: line.convertedFrom,
    source_meal_ids: line.sourceMealIds,
    checked_at: line.checkedAt,
    bought_at: line.boughtAt
  };
}

const RECORD_COLUMNS =
  "line_id uuid, line_key text, name text, quantity numeric, unit text, " +
  "purchase_quantity numeric, purchase_unit text, store_section text, manual boolean, " +
  "covered_by_pantry boolean, not_in_plan boolean, converted_from jsonb, source_meal_ids jsonb, " +
  "checked_at timestamptz, bought_at timestamptz";

const MEAL_IDS = (column: string) => `ARRAY(SELECT jsonb_array_elements_text(${column}))::uuid[]`;

export function sqlListStore(db: MealsDb): ListStore {
  return {
    async readList() {
      const { rows: heads } = await db.query<{ list_id: string; plan_id: string | null }>(
        "SELECT list_id, plan_id FROM app.meals_shopping_lists"
      );
      const head = heads[0];
      if (!head) {
        const { rows } = await db.query<{ list_id: string }>(`SELECT ${LIST_ID_SQL} AS list_id`);
        return { listId: rows[0]!.list_id, exists: false, planId: null, lines: [] };
      }
      const { rows } = await db.query<LineRow>(
        `SELECT ${LINE_COLUMNS} FROM ${ITEMS} WHERE list_id = $1 ORDER BY created_at, line_id`,
        [head.list_id]
      );
      return {
        listId: head.list_id,
        exists: true,
        planId: head.plan_id,
        lines: rows.map(toLine)
      };
    },

    async ensureList(kitchenId, planId) {
      await db.query(
        "INSERT INTO app.meals_shopping_lists (owner_user_id, kitchen_id, list_id) " +
          `VALUES (app.current_actor_user_id(), $1, ${LIST_ID_SQL}) ON CONFLICT DO NOTHING`,
        [kitchenId]
      );
      if (planId !== undefined) {
        await db.query(
          "UPDATE app.meals_shopping_lists SET plan_id = $1, updated_at = now() " +
            "WHERE owner_user_id = app.current_actor_user_id()",
          [planId]
        );
      }
      const { rows } = await db.query<{ list_id: string }>(
        "SELECT list_id FROM app.meals_shopping_lists"
      );
      if (!rows[0]) throw new Error("shopping list not visible after insert");
      return rows[0].list_id;
    },

    async applyDiff(listId, kitchenId, diff: ListDiff, newIds) {
      const inserts = diff.insert.map((line, index) => ({
        line_id: newIds[index]!,
        line_key: line.lineKey,
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        purchase_quantity: line.purchase?.quantity ?? null,
        purchase_unit: unitOrNull(line.purchase),
        store_section: line.section,
        covered_by_pantry: line.coveredByPantry,
        not_in_plan: false,
        converted_from: line.convertedFrom,
        source_meal_ids: line.sourceMealIds
      }));
      const updates = diff.update.map((line) => ({
        line_id: line.lineId,
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        purchase_quantity: line.purchase?.quantity ?? null,
        purchase_unit: unitOrNull(line.purchase),
        store_section: line.section,
        covered_by_pantry: line.coveredByPantry,
        not_in_plan: line.notInPlan,
        converted_from: line.convertedFrom,
        source_meal_ids: line.sourceMealIds
      }));
      const columns =
        "line_id uuid, line_key text, name text, quantity numeric, unit text, " +
        "purchase_quantity numeric, purchase_unit text, store_section text, " +
        "covered_by_pantry boolean, not_in_plan boolean, converted_from jsonb, " +
        "source_meal_ids jsonb";
      await db.query(
        `WITH ins AS (INSERT INTO ${ITEMS} (owner_user_id, kitchen_id, list_id, line_id, line_key, ` +
          "name, quantity, unit, purchase_quantity, purchase_unit, store_section, " +
          "covered_by_pantry, not_in_plan, converted_from, source_meal_ids) " +
          "SELECT app.current_actor_user_id(), $1, $2, x.line_id, x.line_key, x.name, x.quantity, " +
          "x.unit, x.purchase_quantity, x.purchase_unit, x.store_section, x.covered_by_pantry, " +
          `x.not_in_plan, x.converted_from, ${MEAL_IDS("x.source_meal_ids")} ` +
          `FROM jsonb_to_recordset($3::jsonb) AS x(${columns}) ` +
          "ON CONFLICT (owner_user_id, list_id, line_key) " +
          "WHERE line_key IS NOT NULL AND bought_at IS NULL DO NOTHING), " +
          `upd AS (UPDATE ${ITEMS} i SET name = u.name, quantity = u.quantity, unit = u.unit, ` +
          "purchase_quantity = u.purchase_quantity, purchase_unit = u.purchase_unit, " +
          "store_section = u.store_section, covered_by_pantry = u.covered_by_pantry, " +
          "not_in_plan = u.not_in_plan, converted_from = u.converted_from, " +
          `source_meal_ids = ${MEAL_IDS("u.source_meal_ids")}, updated_at = now() ` +
          `FROM jsonb_to_recordset($4::jsonb) AS u(${columns}) ` +
          "WHERE i.line_id = u.line_id AND i.list_id = $2), " +
          `del AS (DELETE FROM ${ITEMS} WHERE list_id = $2 AND line_id = ANY($5::uuid[])), ` +
          `old AS (DELETE FROM ${ITEMS} WHERE list_id = $2 AND bought_at < now() - ${BOUGHT_KEEP}) ` +
          "UPDATE app.meals_shopping_lists SET updated_at = now() WHERE list_id = $2",
        [kitchenId, listId, JSON.stringify(inserts), JSON.stringify(updates), [...diff.remove]]
      );
    },

    async addManual(listId, kitchenId, line) {
      await db.query(
        `INSERT INTO ${ITEMS} (owner_user_id, kitchen_id, list_id, line_id, name, quantity, unit, ` +
          "store_section, manual) VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, " +
          "$7, true)",
        [kitchenId, listId, line.lineId, line.name, line.quantity, line.unit, line.section]
      );
    },

    async updateLine(lineId, patch: LinePatch) {
      const sets: string[] = [];
      const params: unknown[] = [lineId];
      const set = (column: string, cast: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}::${cast}`);
      };
      if (patch.name !== undefined) set("name", "text", patch.name);
      if (patch.section !== undefined) set("store_section", "text", patch.section);
      if (patch.quantity !== undefined) set("quantity", "numeric", patch.quantity);
      if (patch.unit !== undefined) set("unit", "text", patch.unit);
      if (patch.purchase !== undefined) {
        set("purchase_quantity", "numeric", patch.purchase?.quantity ?? null);
        set("purchase_unit", "text", unitOrNull(patch.purchase));
      }
      const { rows } = await db.query<LineRow>(
        `UPDATE ${ITEMS} SET ${[...sets, "updated_at = now()"].join(", ")} ` +
          `WHERE line_id = $1 RETURNING ${LINE_COLUMNS}`,
        params
      );
      return rows[0] ? toLine(rows[0]) : null;
    },

    async setTicks(lineIds, checked) {
      const { rows } = await db.query(
        `UPDATE ${ITEMS} SET checked_at = ${checked ? "coalesce(checked_at, now())" : "NULL"}, ` +
          "updated_at = now() WHERE line_id = ANY($1::uuid[]) AND bought_at IS NULL " +
          "RETURNING line_id",
        [[...lineIds]]
      );
      return rows.length;
    },

    async removeLines(lineIds, undo) {
      await db.query(
        "WITH saved AS (INSERT INTO app.meals_undo_actions " +
          "(owner_user_id, kitchen_id, action_id, kind, before_state) " +
          "VALUES (app.current_actor_user_id(), $1, $2, 'removed', $3::jsonb)) " +
          `DELETE FROM ${ITEMS} WHERE line_id = ANY($4::uuid[])`,
        [
          undo.kitchenId,
          undo.actionId,
          JSON.stringify({ lines: undo.lines.map(lineRecord) }),
          [...lineIds]
        ]
      );
    },

    async clearLines(listId) {
      const { rows } = await db.query(`DELETE FROM ${ITEMS} WHERE list_id = $1 RETURNING line_id`, [
        listId
      ]);
      return rows.length;
    },

    async markBought(input) {
      const pantry = input.rows.map((row) => ({
        line_id: row.lineId,
        item_id: row.itemId,
        name: row.name,
        name_key: row.nameKey,
        quantity: row.quantity,
        unit: row.unit
      }));
      const state = {
        at: input.at,
        lineIds: input.rows.map((row) => row.lineId),
        itemIds: input.rows.map((row) => row.itemId)
      };
      const { rows } = await db.query<{ lines: number; pantry_rows: number }>(
        `WITH upd AS (UPDATE ${ITEMS} SET bought_at = $3::timestamptz, updated_at = now() ` +
          "WHERE list_id = $1 AND line_id = ANY($4::uuid[]) AND bought_at IS NULL " +
          "RETURNING line_id), " +
          "ins AS (INSERT INTO app.meals_pantry_items (owner_user_id, kitchen_id, item_id, name, " +
          "name_key, quantity, unit, source, created_at, updated_at) " +
          "SELECT app.current_actor_user_id(), $2, x.item_id, x.name, x.name_key, x.quantity, " +
          "x.unit, 'bought', $3::timestamptz, $3::timestamptz " +
          "FROM jsonb_to_recordset($5::jsonb) AS x(line_id uuid, item_id uuid, name text, " +
          "name_key text, quantity numeric, unit text) " +
          "WHERE x.line_id IN (SELECT line_id FROM upd) RETURNING item_id), " +
          "undo AS (INSERT INTO app.meals_undo_actions " +
          "(owner_user_id, kitchen_id, action_id, kind, before_state) " +
          "VALUES (app.current_actor_user_id(), $2, $6, 'bought', $7::jsonb)) " +
          "SELECT (SELECT count(*) FROM upd)::int AS lines, " +
          "(SELECT count(*) FROM ins)::int AS pantry_rows",
        [
          input.listId,
          input.kitchenId,
          input.at,
          input.rows.map((row) => row.lineId),
          JSON.stringify(pantry),
          input.actionId,
          JSON.stringify(state)
        ]
      );
      return { lines: rows[0]?.lines ?? 0, pantryRows: rows[0]?.pantry_rows ?? 0 };
    },

    async readUndo(actionId) {
      const { rows } = await db.query<{
        kind: UndoRecord["kind"];
        before_state: Record<string, unknown>;
        undone_at: string | null;
      }>(
        "SELECT kind, before_state, undone_at::text AS undone_at " +
          "FROM app.meals_undo_actions WHERE action_id = $1",
        [actionId]
      );
      const row = rows[0];
      return row
        ? { actionId, kind: row.kind, state: row.before_state, undone: row.undone_at !== null }
        : null;
    },

    async undoRemoved(actionId, listId, kitchenId, lines) {
      const { rows } = await db.query<{ restored: number }>(
        "WITH mark AS (UPDATE app.meals_undo_actions SET undone_at = now() " +
          "WHERE action_id = $1 AND undone_at IS NULL RETURNING action_id), " +
          `back AS (INSERT INTO ${ITEMS} (owner_user_id, kitchen_id, list_id, line_id, line_key, ` +
          "name, quantity, unit, purchase_quantity, purchase_unit, store_section, manual, " +
          "covered_by_pantry, not_in_plan, converted_from, source_meal_ids, checked_at, bought_at) " +
          "SELECT app.current_actor_user_id(), $3, $2, x.line_id, x.line_key, x.name, x.quantity, " +
          "x.unit, x.purchase_quantity, x.purchase_unit, x.store_section, x.manual, " +
          "x.covered_by_pantry, x.not_in_plan, x.converted_from, " +
          `${MEAL_IDS("x.source_meal_ids")}, x.checked_at, x.bought_at ` +
          `FROM jsonb_to_recordset($4::jsonb) AS x(${RECORD_COLUMNS}) ` +
          "WHERE EXISTS (SELECT 1 FROM mark) ON CONFLICT DO NOTHING RETURNING line_id) " +
          "SELECT (SELECT count(*) FROM back)::int AS restored",
        [actionId, listId, kitchenId, JSON.stringify(lines.map(lineRecord))]
      );
      return rows[0]?.restored ?? 0;
    },

    async undoBought(actionId, at, lineIds, itemIds) {
      const { rows } = await db.query<{ restored: number }>(
        "WITH mark AS (UPDATE app.meals_undo_actions SET undone_at = now() " +
          "WHERE action_id = $1 AND undone_at IS NULL RETURNING action_id), " +
          "gone AS (DELETE FROM app.meals_pantry_items WHERE item_id = ANY($3::uuid[]) " +
          "AND updated_at = $2::timestamptz AND EXISTS (SELECT 1 FROM mark) RETURNING item_id), " +
          `cleared AS (UPDATE ${ITEMS} i SET bought_at = NULL, updated_at = now() ` +
          "WHERE i.line_id = ANY($4::uuid[]) AND i.bought_at = $2::timestamptz " +
          "AND EXISTS (SELECT 1 FROM mark) AND NOT EXISTS (SELECT 1 FROM " +
          `${ITEMS} o WHERE o.list_id = i.list_id AND o.line_key = i.line_key ` +
          "AND o.bought_at IS NULL) RETURNING line_id) " +
          "SELECT (SELECT count(*) FROM gone)::int AS restored",
        [actionId, at, [...itemIds], [...lineIds]]
      );
      const restored = rows[0]?.restored ?? 0;
      return { restored, skipped: itemIds.length - restored };
    }
  };
}
