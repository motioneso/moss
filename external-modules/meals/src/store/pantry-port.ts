// external-modules/meals/src/store/pantry-port.ts
//
// The Pantry and Staples store contract. The module database has no transactions, so the write
// that removes an item and the write that stores its Undo record are one statement.
// store/pantry.ts implements it in SQL; the handler tests implement it in memory.
import type { PantryItemView, StapleView } from "../contracts.js";

export interface NewPantryItem {
  readonly itemId: string;
  readonly name: string;
  readonly nameKey: string;
  readonly quantity: number | null;
  readonly unit: string | null;
}

/** Fields to change. Undefined keeps the stored value; null clears an amount or unit. */
export interface PantryPatch {
  readonly name?: string;
  readonly nameKey?: string;
  readonly quantity?: number | null;
  readonly unit?: string | null;
}

export interface PantryStore {
  readItems(): Promise<readonly PantryItemView[]>;
  readStaples(): Promise<readonly StapleView[]>;
  addItem(kitchenId: string, item: NewPantryItem): Promise<void>;
  /** The updated item, or null when no item with this id is visible. */
  updateItem(itemId: string, patch: PantryPatch): Promise<PantryItemView | null>;
  /** Deletes the item and stores the Undo record in one statement. False when it was not there. */
  removeItem(
    itemId: string,
    undo: { readonly actionId: string; readonly kitchenId: string }
  ): Promise<boolean>;
  /**
   * Puts a removed item back from its Undo record's snake_case row and marks the record undone.
   * Returns 1 when it came back, 0 when it could not (already undone, or the id is taken).
   */
  undoRemoved(
    actionId: string,
    kitchenId: string,
    record: Readonly<Record<string, unknown>>
  ): Promise<number>;
  /** False when a Staple with this name already exists. */
  addStaple(
    kitchenId: string,
    staple: { readonly stapleId: string; readonly name: string; readonly nameKey: string }
  ): Promise<boolean>;
  /** The renamed Staple, null when it is not visible, or "taken" when the name is in use. */
  renameStaple(
    stapleId: string,
    name: string,
    nameKey: string
  ): Promise<StapleView | null | "taken">;
  removeStaple(stapleId: string): Promise<boolean>;
}
