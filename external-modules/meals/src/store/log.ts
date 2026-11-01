// external-modules/meals/src/store/log.ts
//
// The meal log over SQL. Every query runs under the module runtime role with RLS scoped to the
// acting owner, so a query names the owner only through app.current_actor_user_id() on insert.
//
// ctx.db has no transactions. A write that touches an entry and its estimate is a compare-and-set
// UPDATE on the entry's estimate_revision followed by INSERTs, so a stale writer cannot overwrite
// a newer one even though the steps are not atomic.
import type {
  CaptureKind,
  EstimateState,
  LogEntryView,
  LogItemView,
  NutrientsView
} from "../contracts.js";
import { sumItemNutrients } from "../log/domain.js";
import { InputError } from "../tools/validate.js";
import type { CorrectItemPatch, LogStore } from "./log-port.js";
import type { MealsDb } from "./sql.js";

const ENTRIES = "app.meals_log_entries";
const ESTIMATES = "app.meals_log_estimates";
const ITEMS = "app.meals_log_estimate_items";

/** An entry joined to its estimate at the entry's current revision. */
const ENTRY_JOIN_ESTIMATE = `
  SELECT m.entry_id, m.consumed_at, m.local_date, m.timezone_offset, m.description,
    m.serving_note, m.capture_kind, m.estimate_state, m.estimate_revision,
    e.calories_kcal, e.protein_g, e.carbohydrates_g, e.fat_g, e.fiber_g, e.sugar_g,
    e.sodium_mg, e.missing_details, e.clarification_question
  FROM ${ENTRIES} m
  LEFT JOIN ${ESTIMATES} e
    ON e.owner_user_id = m.owner_user_id AND e.entry_id = m.entry_id
    AND e.revision = m.estimate_revision
`;

type Numeric = string | number | null;

interface EntryRow {
  entry_id: string;
  consumed_at: unknown;
  local_date: string;
  timezone_offset: number;
  description: string;
  serving_note: string | null;
  capture_kind: CaptureKind;
  estimate_state: EstimateState;
  estimate_revision: number;
  calories_kcal: Numeric;
  protein_g: Numeric;
  carbohydrates_g: Numeric;
  fat_g: Numeric;
  fiber_g: Numeric;
  sugar_g: Numeric;
  sodium_mg: Numeric;
  missing_details: string | null;
  clarification_question: string | null;
}

interface ItemRow {
  entry_id: string;
  item_index: number;
  label: string;
  portion_note: string | null;
  calories_kcal: Numeric;
  protein_g: Numeric;
  carbohydrates_g: Numeric;
  fat_g: Numeric;
  fiber_g: Numeric;
  sugar_g: Numeric;
  sodium_mg: Numeric;
}

// numeric columns come back as strings on most drivers. Null stays null.
function num(value: Numeric): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toItem(row: ItemRow): LogItemView {
  return {
    label: row.label,
    portionNote: row.portion_note,
    nutrients: {
      caloriesKcal: num(row.calories_kcal),
      proteinG: num(row.protein_g),
      carbohydratesG: num(row.carbohydrates_g),
      fatG: num(row.fat_g),
      fiberG: num(row.fiber_g),
      sugarG: num(row.sugar_g),
      sodiumMg: num(row.sodium_mg)
    }
  };
}

function toEntry(row: EntryRow, items: readonly LogItemView[]): LogEntryView {
  const estimated = row.estimate_state === "estimated";
  return {
    entryId: row.entry_id,
    consumedAt: iso(row.consumed_at),
    localDate: row.local_date,
    timezoneOffset: row.timezone_offset,
    description: row.description,
    servingNote: row.serving_note,
    captureKind: row.capture_kind,
    estimateState: row.estimate_state,
    estimateRevision: row.estimate_revision,
    nutrients: estimated
      ? {
          caloriesKcal: num(row.calories_kcal),
          proteinG: num(row.protein_g),
          carbohydratesG: num(row.carbohydrates_g),
          fatG: num(row.fat_g),
          fiberG: num(row.fiber_g),
          sugarG: num(row.sugar_g),
          sodiumMg: num(row.sodium_mg)
        }
      : null,
    items,
    missingDetails: row.estimate_state === "needs_details" ? row.missing_details : null,
    clarificationQuestion:
      row.estimate_state === "needs_details" ? row.clarification_question : null
  };
}

/**
 * Items at each entry's current revision. A second query, because items are one-to-many and a
 * join would repeat every entry row once per item.
 */
async function loadItems(
  db: MealsDb,
  entryIds: readonly string[]
): Promise<Map<string, LogItemView[]>> {
  const byEntry = new Map<string, LogItemView[]>();
  if (entryIds.length === 0) return byEntry;
  const { rows } = await db.query<ItemRow>(
    `SELECT i.entry_id, i.item_index, i.label, i.portion_note, i.calories_kcal, i.protein_g,
       i.carbohydrates_g, i.fat_g, i.fiber_g, i.sugar_g, i.sodium_mg
     FROM ${ITEMS} i
     JOIN ${ENTRIES} m
       ON m.owner_user_id = i.owner_user_id AND m.entry_id = i.entry_id
       AND m.estimate_revision = i.revision
     WHERE i.entry_id = ANY($1::uuid[])
     ORDER BY i.entry_id, i.item_index`,
    [entryIds]
  );
  for (const row of rows) {
    const list = byEntry.get(row.entry_id);
    if (list) list.push(toItem(row));
    else byEntry.set(row.entry_id, [toItem(row)]);
  }
  return byEntry;
}

async function toEntries(db: MealsDb, rows: readonly EntryRow[]): Promise<LogEntryView[]> {
  const items = await loadItems(
    db,
    rows.map((row) => row.entry_id)
  );
  return rows.map((row) => toEntry(row, items.get(row.entry_id) ?? []));
}

/** One multi-row INSERT, so a breakdown is not half written by a failure between statements. */
async function insertItems(
  db: MealsDb,
  entryId: string,
  revision: number,
  items: readonly LogItemView[]
): Promise<void> {
  if (items.length === 0) return;
  const params: unknown[] = [entryId, revision];
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
    `INSERT INTO ${ITEMS} (owner_user_id, entry_id, revision, item_index, label, portion_note,
       calories_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg)
     VALUES ${tuples.join(", ")}`,
    params
  );
}

async function insertEstimate(
  db: MealsDb,
  entryId: string,
  revision: number,
  n: NutrientsView | null,
  missingDetails: string | null,
  clarificationQuestion: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO ${ESTIMATES} (owner_user_id, entry_id, revision, calories_kcal, protein_g,
       carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg, missing_details, clarification_question)
     VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entryId,
      revision,
      n?.caloriesKcal ?? null,
      n?.proteinG ?? null,
      n?.carbohydratesG ?? null,
      n?.fatG ?? null,
      n?.fiberG ?? null,
      n?.sugarG ?? null,
      n?.sodiumMg ?? null,
      missingDetails,
      clarificationQuestion
    ]
  );
}

/**
 * Merges a correction over the current items by position. An omitted field keeps the stored
 * value, so correcting one number never blanks the rest. An item past the end is new and needs a
 * label.
 */
export function mergeItems(
  current: readonly LogItemView[],
  patch: readonly CorrectItemPatch[]
): LogItemView[] {
  const length = Math.max(current.length, patch.length);
  const merged: LogItemView[] = [];
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
      throw new InputError(`items[${index}] is new and needs a label`);
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

export function sqlLogStore(db: MealsDb): LogStore {
  async function readOne(entryId: string): Promise<LogEntryView | null> {
    const { rows } = await db.query<EntryRow>(`${ENTRY_JOIN_ESTIMATE} WHERE m.entry_id = $1`, [
      entryId
    ]);
    return rows.length === 0 ? null : (await toEntries(db, rows))[0]!;
  }

  return {
    async createEntry(input) {
      const inserted = await db.query<{ entry_id: string }>(
        `INSERT INTO ${ENTRIES} (owner_user_id, entry_id, consumed_at, local_date, timezone_offset,
           description, serving_note, capture_kind, estimate_state, estimate_revision,
           idempotency_key)
         VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, 'pending', 1, $8)
         ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
         RETURNING entry_id`,
        [
          input.entryId,
          input.consumedAt,
          input.localDate,
          input.timezoneOffset,
          input.description,
          input.servingNote,
          input.captureKind,
          input.idempotencyKey
        ]
      );
      if (inserted.rows.length > 0) {
        const entry = await readOne(input.entryId);
        if (entry === null) throw new Error("entry not visible after insert");
        return { entry, created: true };
      }
      const { rows } = await db.query<EntryRow>(
        `${ENTRY_JOIN_ESTIMATE} WHERE m.idempotency_key = $1`,
        [input.idempotencyKey]
      );
      if (rows.length === 0) throw new Error("idempotency conflict but no existing entry found");
      return { entry: (await toEntries(db, rows))[0]!, created: false };
    },

    getEntry: readOne,

    async listForLocalDate(localDate) {
      const { rows } = await db.query<EntryRow>(
        `${ENTRY_JOIN_ESTIMATE} WHERE m.local_date = $1 ORDER BY m.consumed_at ASC, m.entry_id`,
        [localDate]
      );
      return toEntries(db, rows);
    },

    async listForDateRange(fromLocalDate, toLocalDate) {
      const { rows } = await db.query<EntryRow>(
        `${ENTRY_JOIN_ESTIMATE} WHERE m.local_date BETWEEN $1 AND $2
         ORDER BY m.consumed_at ASC, m.entry_id`,
        [fromLocalDate, toLocalDate]
      );
      return toEntries(db, rows);
    },

    async recordEstimate(entryId, expectedRevision, outcome) {
      const updated = await db.query<{ estimate_revision: number }>(
        `UPDATE ${ENTRIES}
         SET estimate_state = $3, estimate_revision = estimate_revision + 1, updated_at = now()
         WHERE entry_id = $1 AND estimate_revision = $2
         RETURNING estimate_revision`,
        [entryId, expectedRevision, outcome.state]
      );
      if (updated.rows.length === 0) return null;

      const revision = updated.rows[0]!.estimate_revision;
      await insertEstimate(
        db,
        entryId,
        revision,
        outcome.nutrients,
        outcome.missingDetails,
        outcome.clarificationQuestion
      );
      // Items reference the estimate row, so they go in after it.
      await insertItems(db, entryId, revision, outcome.items);
      return readOne(entryId);
    },

    async correctEntry(entryId, expectedRevision, patch) {
      const current = await readOne(entryId);
      if (current === null || current.estimateRevision !== expectedRevision) return null;

      // Merged before the UPDATE so a patch that cannot apply fails without moving the revision.
      const mergedItems = patch.items ? mergeItems(current.items, patch.items) : null;
      const nextState: EstimateState = mergedItems ? "estimated" : current.estimateState;
      const updated = await db.query<{ estimate_revision: number }>(
        `UPDATE ${ENTRIES}
         SET description = COALESCE($3, description),
             serving_note = CASE WHEN $4::boolean THEN $5 ELSE serving_note END,
             consumed_at = COALESCE($6, consumed_at),
             local_date = COALESCE($7, local_date),
             timezone_offset = COALESCE($8, timezone_offset),
             estimate_state = $9,
             estimate_revision = estimate_revision + 1,
             updated_at = now()
         WHERE entry_id = $1 AND estimate_revision = $2
         RETURNING estimate_revision`,
        [
          entryId,
          expectedRevision,
          patch.description ?? null,
          patch.servingNote !== undefined,
          patch.servingNote ?? null,
          patch.consumedAt ?? null,
          patch.localDate ?? null,
          patch.timezoneOffset ?? null,
          nextState
        ]
      );
      if (updated.rows.length === 0) return null;

      const revision = updated.rows[0]!.estimate_revision;
      if (mergedItems) {
        await insertEstimate(db, entryId, revision, sumItemNutrients(mergedItems), null, null);
        await insertItems(db, entryId, revision, mergedItems);
      } else {
        // A text or time edit still moves the revision, and the estimate is read at the current
        // revision, so the previous estimate and items are copied forward. Both copies are no-ops
        // when the entry never estimated.
        await db.query(
          `INSERT INTO ${ESTIMATES} (owner_user_id, entry_id, revision, calories_kcal, protein_g,
             carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg, missing_details,
             clarification_question)
           SELECT owner_user_id, entry_id, $2, calories_kcal, protein_g, carbohydrates_g, fat_g,
             fiber_g, sugar_g, sodium_mg, missing_details, clarification_question
           FROM ${ESTIMATES} WHERE entry_id = $1 AND revision = $3`,
          [entryId, revision, expectedRevision]
        );
        await db.query(
          `INSERT INTO ${ITEMS} (owner_user_id, entry_id, revision, item_index, label,
             portion_note, calories_kcal, protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g,
             sodium_mg)
           SELECT owner_user_id, entry_id, $2, item_index, label, portion_note, calories_kcal,
             protein_g, carbohydrates_g, fat_g, fiber_g, sugar_g, sodium_mg
           FROM ${ITEMS} WHERE entry_id = $1 AND revision = $3`,
          [entryId, revision, expectedRevision]
        );
      }
      return readOne(entryId);
    },

    async markPending(entryId, expectedRevision) {
      const { rows } = await db.query(
        `UPDATE ${ENTRIES} SET estimate_state = 'pending', updated_at = now()
         WHERE entry_id = $1 AND estimate_revision = $2 AND estimate_state = 'failed'
         RETURNING entry_id`,
        [entryId, expectedRevision]
      );
      return rows.length === 0 ? null : readOne(entryId);
    },

    async deleteEntry(entryId) {
      const { rows } = await db.query(
        `DELETE FROM ${ENTRIES} WHERE entry_id = $1 RETURNING entry_id`,
        [entryId]
      );
      return rows.length > 0;
    }
  };
}
