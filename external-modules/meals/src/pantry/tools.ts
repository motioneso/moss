// external-modules/meals/src/pantry/tools.ts
//
// The meals.pantry.* tool handlers. pantry.get never writes. pantry.edit adds, changes and
// removes Pantry items and Staples, and returns the whole Pantry so the page and Moss see the
// result without a second read. Removing an item returns an Undo token.
import type { KitchenView, PantryEditResult, PantryView, UndoToken } from "../contracts.js";
import { ingredientKey } from "../domain/list.js";
import { normaliseUnit } from "../domain/units.js";
import type { PantryStore } from "../store/pantry-port.js";
import {
  InputError,
  readEnum,
  readText,
  readUuid,
  requireNoUnknownKeys
} from "../tools/validate.js";

type Input = Record<string, unknown>;

export interface PantryDeps {
  readonly pantry: PantryStore;
  /** The kitchen, read without writing. Read tools may only run SELECT. */
  readonly kitchen: () => Promise<KitchenView>;
  /** The kitchen, with its row stored. Write tools call it. */
  readonly ensureKitchen: () => Promise<KitchenView>;
  readonly newId: () => string;
  /** Called after any Pantry or Staple change so a shopping list tied to a plan can rebuild. */
  readonly onPantryChange?: () => Promise<void>;
}

const MAX_QUANTITY = 1_000_000;
const NO_ITEM = "There is no Pantry item with that id";
const NO_STAPLE = "There is no Staple with that id";

function readQuantity(input: Input): number | null | undefined {
  const value = input.quantity;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) {
    throw new InputError("quantity must be a number above 0, or null for no amount");
  }
  return Math.round(value * 1000) / 1000;
}

function readUnit(input: Input): string | null | undefined {
  if (input.unit === null) return null;
  const text = readText(input, "unit", { maxChars: 24 });
  return text === undefined ? undefined : normaliseUnit(text);
}

async function viewOf(deps: PantryDeps): Promise<PantryView> {
  const [items, staples] = await Promise.all([deps.pantry.readItems(), deps.pantry.readStaples()]);
  return { items, staples };
}

const GET_KEYS = new Set<string>();
export async function pantryGet(deps: PantryDeps, input: Input): Promise<PantryView> {
  requireNoUnknownKeys(input, GET_KEYS);
  return viewOf(deps);
}

const EDIT_KEYS = new Set(["action", "target", "itemId", "stapleId", "name", "quantity", "unit"]);
const ACTIONS = ["add", "update", "remove"] as const;
const TARGETS = ["item", "staple"] as const;

async function editItem(
  deps: PantryDeps,
  action: (typeof ACTIONS)[number],
  input: Input
): Promise<UndoToken | null> {
  if (action === "add") {
    const name = readText(input, "name", { required: true, maxChars: 80 })!;
    const kitchen = await deps.ensureKitchen();
    await deps.pantry.addItem(kitchen.kitchenId, {
      itemId: deps.newId(),
      name,
      nameKey: ingredientKey(name),
      quantity: readQuantity(input) ?? null,
      unit: readUnit(input) ?? null
    });
    return null;
  }
  const itemId = readUuid(input, "itemId", { required: true });
  if (action === "update") {
    const name = readText(input, "name", { maxChars: 80 });
    const updated = await deps.pantry.updateItem(itemId, {
      ...(name !== undefined ? { name, nameKey: ingredientKey(name) } : {}),
      ...(input.quantity !== undefined ? { quantity: readQuantity(input) } : {}),
      ...(input.unit !== undefined ? { unit: readUnit(input) } : {})
    });
    if (updated === null) throw new InputError(NO_ITEM);
    return null;
  }
  const kitchen = await deps.kitchen();
  const actionId = deps.newId();
  if (!(await deps.pantry.removeItem(itemId, { actionId, kitchenId: kitchen.kitchenId }))) {
    throw new InputError(NO_ITEM);
  }
  return { actionId, kind: "removed", count: 1 };
}

async function editStaple(deps: PantryDeps, action: (typeof ACTIONS)[number], input: Input) {
  if (action === "add") {
    const name = readText(input, "name", { required: true, maxChars: 80 })!;
    const kitchen = await deps.ensureKitchen();
    // A Staple already on the list is not an error; the result shows it once.
    await deps.pantry.addStaple(kitchen.kitchenId, {
      stapleId: deps.newId(),
      name,
      nameKey: ingredientKey(name)
    });
    return;
  }
  const stapleId = readUuid(input, "stapleId", { required: true });
  if (action === "update") {
    const name = readText(input, "name", { required: true, maxChars: 80 })!;
    const renamed = await deps.pantry.renameStaple(stapleId, name, ingredientKey(name));
    if (renamed === null) throw new InputError(NO_STAPLE);
    if (renamed === "taken") throw new InputError("That Staple is already on the list");
    return;
  }
  if (!(await deps.pantry.removeStaple(stapleId))) throw new InputError(NO_STAPLE);
}

export async function pantryEdit(deps: PantryDeps, input: Input): Promise<PantryEditResult> {
  requireNoUnknownKeys(input, EDIT_KEYS);
  const action = readEnum(input, "action", ACTIONS, { required: true });
  const target = readEnum(input, "target", TARGETS) ?? "item";
  let undo: UndoToken | null = null;
  if (target === "item") undo = await editItem(deps, action, input);
  else await editStaple(deps, action, input);
  await deps.onPantryChange?.();
  return { pantry: await viewOf(deps), undo };
}
