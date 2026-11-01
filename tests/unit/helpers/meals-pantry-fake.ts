// tests/unit/helpers/meals-pantry-fake.ts
//
// An in-memory PantryStore for the Pantry handler and day job tests. It follows the SQL store's
// observable rules: removing an item stores an Undo record in the same call, and restoring a
// record twice brings the item back once.
import type { PantryItemView, StapleView } from "../../../external-modules/meals/src/contracts.js";
import type { UndoRecord } from "../../../external-modules/meals/src/store/list-port.js";
import type {
  NewPantryItem,
  PantryPatch,
  PantryStore
} from "../../../external-modules/meals/src/store/pantry-port.js";

export class FakePantryStore implements PantryStore {
  readonly items = new Map<string, PantryItemView>();
  readonly staples = new Map<string, StapleView & { nameKey: string }>();
  readonly undos = new Map<string, { record: Record<string, unknown>; undone: boolean }>();
  private clock = 0;

  /** The list store's Undo records, where the shared Undo tool looks for them. */
  constructor(private readonly mirror: Map<string, UndoRecord> = new Map()) {}

  seed(name: string, quantity: number | null = null, unit: string | null = null): string {
    const itemId = `00000000-0000-4000-9000-${(this.items.size + 1).toString().padStart(12, "0")}`;
    this.items.set(itemId, {
      itemId,
      name,
      quantity,
      unit,
      source: "manual",
      updatedAt: this.stamp()
    });
    return itemId;
  }

  private stamp(): string {
    this.clock += 1;
    return `2026-11-02T00:00:${String(this.clock).padStart(2, "0")}.000Z`;
  }

  async readItems() {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async readStaples() {
    return [...this.staples.values()].map(({ stapleId, name }) => ({ stapleId, name }));
  }

  async addItem(_kitchenId: string, item: NewPantryItem) {
    this.items.set(item.itemId, {
      itemId: item.itemId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      source: "manual",
      updatedAt: this.stamp()
    });
  }

  async updateItem(itemId: string, patch: PantryPatch) {
    const found = this.items.get(itemId);
    if (found === undefined) return null;
    const next: PantryItemView = {
      ...found,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
      ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
      updatedAt: this.stamp()
    };
    this.items.set(itemId, next);
    return next;
  }

  async removeItem(itemId: string, undo: { actionId: string; kitchenId: string }) {
    const found = this.items.get(itemId);
    if (found === undefined) return false;
    this.items.delete(itemId);
    const record = {
      item_id: found.itemId,
      name: found.name,
      name_key: found.name.toLowerCase(),
      quantity: found.quantity,
      unit: found.unit,
      source: found.source,
      created_at: found.updatedAt
    };
    this.mirror.set(undo.actionId, {
      actionId: undo.actionId,
      kind: "removed",
      state: { item: record },
      undone: false
    });
    this.undos.set(undo.actionId, { undone: false, record });
    return true;
  }

  async undoRemoved(
    actionId: string,
    _kitchenId: string,
    record: Readonly<Record<string, unknown>>
  ) {
    const stored = this.undos.get(actionId);
    if (stored === undefined || stored.undone) return 0;
    stored.undone = true;
    const mirrored = this.mirror.get(actionId);
    if (mirrored) this.mirror.set(actionId, { ...mirrored, undone: true });
    const itemId = record["item_id"] as string;
    if (this.items.has(itemId)) return 0;
    this.items.set(itemId, {
      itemId,
      name: record["name"] as string,
      quantity: (record["quantity"] as number | null) ?? null,
      unit: (record["unit"] as string | null) ?? null,
      source: record["source"] as PantryItemView["source"],
      updatedAt: this.stamp()
    });
    return 1;
  }

  async addStaple(_kitchenId: string, staple: { stapleId: string; name: string; nameKey: string }) {
    if ([...this.staples.values()].some((s) => s.nameKey === staple.nameKey)) return false;
    this.staples.set(staple.stapleId, staple);
    return true;
  }

  async renameStaple(stapleId: string, name: string, nameKey: string) {
    const found = this.staples.get(stapleId);
    if (found === undefined) return null;
    if ([...this.staples.values()].some((s) => s.nameKey === nameKey && s.stapleId !== stapleId)) {
      return "taken" as const;
    }
    this.staples.set(stapleId, { stapleId, name, nameKey });
    return { stapleId, name };
  }

  async removeStaple(stapleId: string) {
    return this.staples.delete(stapleId);
  }
}
