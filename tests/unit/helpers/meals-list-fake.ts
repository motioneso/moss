// tests/unit/helpers/meals-list-fake.ts
//
// An in-memory ListStore for the shopping list handler tests. It follows the SQL store's
// observable rules: bought lines leave the open set, undoing Bought skips Pantry rows edited since,
// and the undo record holds lines in the same snake_case shape the SQL store writes.
import type { ListDiff, StoredLine } from "../../../external-modules/meals/src/domain/list.js";
import type { ListDeps } from "../../../external-modules/meals/src/lists/deps.js";
import type {
  LinePatch,
  ListStore,
  NewManualLine,
  StoredList,
  UndoRecord
} from "../../../external-modules/meals/src/store/list-port.js";
import type { KitchenView } from "../../../external-modules/meals/src/contracts.js";
import { sequentialIds, type FakePlanStore } from "./meals-plan-fake.js";

export interface FakePantryRow {
  itemId: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  updatedAt: string;
}

function lineRecord(line: StoredLine): Record<string, unknown> {
  return {
    line_id: line.lineId,
    line_key: line.lineKey,
    manual: line.manual,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    purchase_quantity: line.purchase?.quantity ?? null,
    purchase_unit: line.purchase?.unit ?? null,
    store_section: line.section,
    covered_by_pantry: line.coveredByPantry,
    not_in_plan: line.notInPlan,
    converted_from: line.convertedFrom,
    source_meal_ids: line.sourceMealIds,
    checked_at: line.checkedAt,
    bought_at: line.boughtAt
  };
}

export class FakeListStore implements ListStore {
  readonly lines = new Map<string, StoredLine>();
  readonly pantry = new Map<string, FakePantryRow>();
  readonly undos = new Map<string, UndoRecord>();
  exists = false;
  planId: string | null = null;
  readonly listId = "00000000-0000-4000-8000-0000000000aa";

  async readList(): Promise<StoredList> {
    return {
      listId: this.listId,
      exists: this.exists,
      planId: this.planId,
      lines: [...this.lines.values()]
    };
  }

  async ensureList(_kitchenId: string, planId: string | null | undefined): Promise<string> {
    this.exists = true;
    if (planId !== undefined) this.planId = planId;
    return this.listId;
  }

  async applyDiff(
    _listId: string,
    _kitchenId: string,
    diff: ListDiff,
    newIds: readonly string[]
  ): Promise<void> {
    diff.insert.forEach((line, index) => {
      const lineId = newIds[index]!;
      this.lines.set(lineId, {
        lineId,
        lineKey: line.lineKey,
        manual: false,
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        purchase: line.purchase,
        section: line.section,
        coveredByPantry: line.coveredByPantry,
        notInPlan: false,
        convertedFrom: line.convertedFrom,
        sourceMealIds: line.sourceMealIds,
        checkedAt: null,
        boughtAt: null
      });
    });
    for (const change of diff.update) {
      const line = this.lines.get(change.lineId);
      if (line) this.lines.set(change.lineId, { ...line, ...change });
    }
    for (const lineId of diff.remove) this.lines.delete(lineId);
  }

  async addManual(_listId: string, _kitchenId: string, line: NewManualLine): Promise<void> {
    this.lines.set(line.lineId, {
      lineId: line.lineId,
      lineKey: null,
      manual: true,
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      purchase: null,
      section: line.section,
      coveredByPantry: false,
      notInPlan: false,
      convertedFrom: [],
      sourceMealIds: [],
      checkedAt: null,
      boughtAt: null
    });
  }

  async updateLine(lineId: string, patch: LinePatch): Promise<StoredLine | null> {
    const line = this.lines.get(lineId);
    if (!line) return null;
    const next = { ...line, ...patch } as StoredLine;
    this.lines.set(lineId, next);
    return next;
  }

  async setTicks(lineIds: readonly string[], checked: boolean): Promise<number> {
    let changed = 0;
    for (const lineId of lineIds) {
      const line = this.lines.get(lineId);
      if (!line || line.boughtAt !== null) continue;
      this.lines.set(lineId, { ...line, checkedAt: checked ? (line.checkedAt ?? "ticked") : null });
      changed += 1;
    }
    return changed;
  }

  async removeLines(
    lineIds: readonly string[],
    undo: { actionId: string; kitchenId: string; lines: readonly StoredLine[] }
  ): Promise<void> {
    this.undos.set(undo.actionId, {
      actionId: undo.actionId,
      kind: "removed",
      state: { lines: undo.lines.map(lineRecord) },
      undone: false
    });
    for (const lineId of lineIds) this.lines.delete(lineId);
  }

  async clearLines(): Promise<number> {
    const count = this.lines.size;
    this.lines.clear();
    return count;
  }

  async markBought(input: Parameters<ListStore["markBought"]>[0]) {
    let stamped = 0;
    let pantryRows = 0;
    for (const row of input.rows) {
      const line = this.lines.get(row.lineId);
      if (!line || line.boughtAt !== null) continue;
      this.lines.set(row.lineId, { ...line, boughtAt: input.at });
      stamped += 1;
      this.pantry.set(row.itemId, {
        itemId: row.itemId,
        name: row.name,
        quantity: row.quantity,
        unit: row.unit,
        updatedAt: input.at
      });
      pantryRows += 1;
    }
    this.undos.set(input.actionId, {
      actionId: input.actionId,
      kind: "bought",
      state: {
        at: input.at,
        lineIds: input.rows.map((row) => row.lineId),
        itemIds: input.rows.map((row) => row.itemId)
      },
      undone: false
    });
    return { lines: stamped, pantryRows };
  }

  async readUndo(actionId: string): Promise<UndoRecord | null> {
    return this.undos.get(actionId) ?? null;
  }

  async undoRemoved(
    actionId: string,
    _listId: string,
    _kitchenId: string,
    lines: readonly StoredLine[]
  ): Promise<number> {
    const record = this.undos.get(actionId);
    if (!record || record.undone) return 0;
    this.undos.set(actionId, { ...record, undone: true });
    for (const line of lines) this.lines.set(line.lineId, line);
    return lines.length;
  }

  async undoBought(
    actionId: string,
    at: string,
    lineIds: readonly string[],
    itemIds: readonly string[]
  ) {
    const record = this.undos.get(actionId);
    if (!record || record.undone) return { restored: 0, skipped: itemIds.length };
    this.undos.set(actionId, { ...record, undone: true });
    let restored = 0;
    for (const itemId of itemIds) {
      const row = this.pantry.get(itemId);
      if (row && row.updatedAt === at) {
        this.pantry.delete(itemId);
        restored += 1;
      }
    }
    for (const lineId of lineIds) {
      const line = this.lines.get(lineId);
      if (line && line.boughtAt === at) this.lines.set(lineId, { ...line, boughtAt: null });
    }
    return { restored, skipped: itemIds.length - restored };
  }
}

export function fakeListDeps(plans: FakePlanStore, kitchen: KitchenView) {
  const lists = new FakeListStore();
  const ids = sequentialIds();
  const deps: ListDeps = {
    lists,
    plans,
    kitchen: async () => kitchen,
    ensureKitchen: async () => kitchen,
    newId: ids,
    now: () => new Date("2026-11-02T19:00:00Z")
  };
  return { deps, lists };
}
