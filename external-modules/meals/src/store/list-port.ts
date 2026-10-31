// external-modules/meals/src/store/list-port.ts
//
// The shopping list store contract. The module database has no transactions, so every write that
// touches more than one row or table is a single statement. store/list.ts implements it in SQL;
// the handler tests implement it in memory.
import type { StoreSection } from "../contracts.js";
import type { ListDiff, Purchase, StoredLine } from "../domain/list.js";

export interface StoredList {
  /** The stored list's id, or the id it will get on first write. */
  readonly listId: string;
  readonly exists: boolean;
  readonly planId: string | null;
  readonly lines: readonly StoredLine[];
}

export interface NewManualLine {
  readonly lineId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly section: StoreSection;
}

/** Fields to change. Undefined keeps the stored value; null clears a nullable one. */
export interface LinePatch {
  readonly name?: string;
  readonly section?: StoreSection;
  readonly quantity?: number | null;
  readonly unit?: string | null;
  readonly purchase?: Purchase | null;
}

export interface BoughtRow {
  readonly lineId: string;
  readonly itemId: string;
  readonly name: string;
  readonly nameKey: string;
  readonly quantity: number | null;
  readonly unit: string | null;
}

export interface UndoRecord {
  readonly actionId: string;
  readonly kind: "bought" | "cooked" | "removed";
  readonly state: Readonly<Record<string, unknown>>;
  readonly undone: boolean;
}

export interface ListStore {
  /** The owner's list without writing. Before the first write it is empty with a derived id. */
  readList(): Promise<StoredList>;
  /** Stores the list on first use and points it at the plan. Returns the list id. */
  ensureList(kitchenId: string, planId: string | null | undefined): Promise<string>;
  /** Applies a rebuild diff in one statement. `newIds` pairs with `diff.insert`. */
  applyDiff(
    listId: string,
    kitchenId: string,
    diff: ListDiff,
    newIds: readonly string[]
  ): Promise<void>;
  addManual(listId: string, kitchenId: string, line: NewManualLine): Promise<void>;
  /** The updated line, or null when no line with this id is visible. */
  updateLine(lineId: string, patch: LinePatch): Promise<StoredLine | null>;
  /** Ticks or unticks the lines. Returns how many lines changed. */
  setTicks(lineIds: readonly string[], checked: boolean): Promise<number>;
  /** Deletes the lines and stores the undo record in one statement. */
  removeLines(
    lineIds: readonly string[],
    undo: {
      readonly actionId: string;
      readonly kitchenId: string;
      readonly lines: readonly StoredLine[];
    }
  ): Promise<void>;
  /** Deletes every line. Returns how many were deleted. */
  clearLines(listId: string): Promise<number>;
  /**
   * Stamps the lines bought, writes a Pantry row for each and stores the undo record, in one
   * statement. Returns how many lines were stamped and how many Pantry rows were written.
   */
  markBought(input: {
    readonly listId: string;
    readonly kitchenId: string;
    readonly at: string;
    readonly actionId: string;
    readonly rows: readonly BoughtRow[];
  }): Promise<{ readonly lines: number; readonly pantryRows: number }>;
  readUndo(actionId: string): Promise<UndoRecord | null>;
  /** Puts removed lines back and marks the record undone. Returns how many came back. */
  undoRemoved(
    actionId: string,
    listId: string,
    kitchenId: string,
    lines: readonly StoredLine[]
  ): Promise<number>;
  /**
   * Clears bought_at on the lines and deletes the Pantry rows Bought wrote, skipping any row
   * edited since. Returns the rows removed and the rows skipped.
   */
  undoBought(
    actionId: string,
    at: string,
    lineIds: readonly string[],
    itemIds: readonly string[]
  ): Promise<{ readonly restored: number; readonly skipped: number }>;
}
