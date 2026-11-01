// external-modules/meals/src/lists/tools.ts
//
// The meals.list.* and meals.undo tool handlers. list.get never writes. Every write that changes
// lines returns the whole list so the page and Moss see the result without a second read.
import type {
  BoughtResult,
  ListEditResult,
  PantryMode,
  ShoppingListView,
  StoreSection,
  UndoResult,
  UndoToken
} from "../contracts.js";
import {
  buildList,
  ingredientKey,
  reconcileList,
  SECTION_ORDER,
  type ListMealInput,
  type StoredLine
} from "../domain/list.js";
import { normaliseUnit } from "../domain/units.js";
import type { StoredList } from "../store/list-port.js";
import type { RecipeRow } from "../store/plan-port.js";
import {
  InputError,
  readEnum,
  readText,
  readUuid,
  requireNoUnknownKeys
} from "../tools/validate.js";
import type { ListDeps } from "./deps.js";
import { listView, mealLabel } from "./view.js";

type Input = Record<string, unknown>;

const MAX_BATCH = 100;
const MAX_QUANTITY = 1_000_000;
const NO_LIST = "There is no shopping list line with that id";

function readQuantity(input: Input, key: string): number | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_QUANTITY) {
    throw new InputError(`${key} must be a number above 0`);
  }
  return Math.round(value * 1000) / 1000;
}

function readUnit(input: Input, key: string): string | null | undefined {
  if (input[key] === null) return null;
  const text = readText(input, key, { maxChars: 24 });
  return text === undefined ? undefined : (normaliseUnit(text) ?? null);
}

function readIdList(input: Input, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH) {
    throw new InputError(`${key} must hold 1 to ${MAX_BATCH} line ids`);
  }
  return value.map((_, index) => readUuid({ id: value[index] }, "id", { required: true }));
}

interface PlanContext {
  readonly pantryMode: PantryMode | null;
  readonly labels: Map<string, string>;
  readonly meals: ListMealInput[];
}

/** The plan's ready meals as list input, plus a label for each meal. Empty when no plan. */
async function planContext(deps: ListDeps, planId: string | null): Promise<PlanContext> {
  const empty: PlanContext = { pantryMode: null, labels: new Map(), meals: [] };
  if (planId === null) return empty;
  const plan = await deps.plans.getPlan(planId);
  if (plan === null) return empty;
  const [days, meals] = await Promise.all([
    deps.plans.listDays(planId),
    deps.plans.listMeals(planId)
  ]);
  const dateOf = new Map(days.map((day) => [day.dayId, day.date]));
  const recipeIds = [...new Set(meals.flatMap((meal) => (meal.recipeId ? [meal.recipeId] : [])))];
  const recipes: readonly RecipeRow[] =
    recipeIds.length > 0 ? await deps.plans.getRecipes(recipeIds) : [];
  const recipeOf = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));

  const labels = new Map<string, string>();
  const inputs: ListMealInput[] = [];
  for (const meal of meals) {
    labels.set(meal.mealId, mealLabel(dateOf.get(meal.dayId) ?? plan.startDate, meal.slotName));
    const recipe = meal.recipeId ? recipeOf.get(meal.recipeId) : undefined;
    if (meal.status !== "ready" || recipe === undefined) continue;
    const eaten = meal.eaters.reduce((sum, eater) => sum + eater.portion, 0);
    inputs.push({
      mealId: meal.mealId,
      servings: meal.servingsOverride ?? (eaten > 0 ? eaten : recipe.baseServings),
      baseServings: recipe.baseServings,
      ingredients: recipe.ingredients.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        section: line.section
      }))
    });
  }
  return { pantryMode: plan.pantryMode, labels, meals: inputs };
}

async function viewOf(deps: ListDeps, stored: StoredList): Promise<ShoppingListView> {
  const [context, kitchen] = await Promise.all([planContext(deps, stored.planId), deps.kitchen()]);
  return listView(stored, context.pantryMode ?? kitchen.defaultPantryMode, context.labels);
}

/** Rebuilds the stored list from its plan. `empty` rebuilds as if the plan had no meals. */
export async function rebuildList(
  deps: ListDeps,
  stored: StoredList,
  kitchenId: string,
  empty = false
): Promise<void> {
  const context = await planContext(deps, empty ? null : stored.planId);
  const generated = buildList({ meals: context.meals });
  const diff = reconcileList(stored.lines, generated);
  if (diff.insert.length + diff.update.length + diff.remove.length === 0) return;
  await deps.lists.applyDiff(
    stored.listId,
    kitchenId,
    diff,
    diff.insert.map(() => deps.newId())
  );
}

/** Plan hook. Rebuilds the list that is tied to the plan, if there is one. */
export async function listOnPlanChange(
  deps: ListDeps,
  planId: string,
  change: "written" | "deleted"
): Promise<void> {
  const stored = await deps.lists.readList();
  if (!stored.exists || stored.planId !== planId) return;
  const kitchen = await deps.kitchen();
  await rebuildList(deps, stored, kitchen.kitchenId, change === "deleted");
}

const GET_KEYS = new Set<string>();
export async function listGet(deps: ListDeps, input: Input): Promise<ShoppingListView> {
  requireNoUnknownKeys(input, GET_KEYS);
  return viewOf(deps, await deps.lists.readList());
}

const BUILD_KEYS = new Set(["planId"]);
export async function listBuild(deps: ListDeps, input: Input): Promise<ShoppingListView> {
  requireNoUnknownKeys(input, BUILD_KEYS);
  const planId = readUuid(input, "planId", { required: true });
  if ((await deps.plans.getPlan(planId)) === null) throw new InputError("No plan with that id");
  const kitchen = await deps.ensureKitchen();
  await deps.lists.ensureList(kitchen.kitchenId, planId);
  const stored = await deps.lists.readList();
  await rebuildList(deps, stored, kitchen.kitchenId);
  return viewOf(deps, await deps.lists.readList());
}

const EDIT_KEYS = new Set(["action", "lineId", "lineIds", "name", "quantity", "unit", "section"]);
const EDIT_ACTIONS = ["add", "update", "remove", "tick", "untick"] as const;

function findLine(stored: StoredList, lineId: string): StoredLine {
  const line = stored.lines.find((candidate) => candidate.lineId === lineId);
  if (line === undefined) throw new InputError(NO_LIST);
  return line;
}

export async function listEdit(deps: ListDeps, input: Input): Promise<ListEditResult> {
  requireNoUnknownKeys(input, EDIT_KEYS);
  const action = readEnum(input, "action", EDIT_ACTIONS, { required: true });
  let undo: UndoToken | null = null;

  if (action === "add") {
    const name = readText(input, "name", { required: true, maxChars: 80 })!;
    const kitchen = await deps.ensureKitchen();
    const listId = await deps.lists.ensureList(kitchen.kitchenId, undefined);
    await deps.lists.addManual(listId, kitchen.kitchenId, {
      lineId: deps.newId(),
      name,
      quantity: readQuantity(input, "quantity") ?? null,
      unit: readUnit(input, "unit") ?? null,
      section: readEnum(input, "section", SECTION_ORDER) ?? "other"
    });
  } else if (action === "update") {
    const stored = await deps.lists.readList();
    const line = findLine(stored, readUuid(input, "lineId", { required: true }));
    const quantity = readQuantity(input, "quantity");
    const unit = readUnit(input, "unit");
    const patch: {
      name?: string;
      section?: StoreSection;
      quantity?: number | null;
      unit?: string | null;
      purchase?: { quantity: number; unit: string } | null;
    } = {};
    const name = readText(input, "name", { maxChars: 80 });
    if (name !== undefined) patch.name = name;
    const section = readEnum(input, "section", SECTION_ORDER);
    if (section !== undefined) patch.section = section;
    if (line.manual) {
      if (quantity !== undefined) patch.quantity = quantity;
      if (unit !== undefined) patch.unit = unit;
    } else if (quantity !== undefined || unit !== undefined) {
      // A built line keeps what the recipes need; the shopper edits the amount to buy.
      const amount = quantity ?? line.purchase?.quantity ?? line.quantity;
      if (amount === null) throw new InputError("quantity is required for this line");
      patch.purchase = {
        quantity: amount,
        unit: unit ?? line.purchase?.unit ?? normaliseUnit(line.unit) ?? ""
      };
    }
    if ((await deps.lists.updateLine(line.lineId, patch)) === null) throw new InputError(NO_LIST);
  } else if (action === "remove") {
    const stored = await deps.lists.readList();
    const line = findLine(stored, readUuid(input, "lineId", { required: true }));
    const kitchen = await deps.kitchen();
    const actionId = deps.newId();
    await deps.lists.removeLines([line.lineId], {
      actionId,
      kitchenId: kitchen.kitchenId,
      lines: [line]
    });
    undo = { actionId, kind: "removed", count: 1 };
  } else {
    const ids =
      input.lineIds !== undefined
        ? readIdList(input, "lineIds")
        : [readUuid(input, "lineId", { required: true })];
    await deps.lists.setTicks(ids, action === "tick");
  }

  return { list: await viewOf(deps, await deps.lists.readList()), undo };
}

const BOUGHT_KEYS = new Set(["lines"]);

export async function listBought(deps: ListDeps, input: Input): Promise<BoughtResult> {
  requireNoUnknownKeys(input, BOUGHT_KEYS);
  const stored = await deps.lists.readList();
  const open = stored.lines.filter((line) => line.boughtAt === null);

  const picks: Array<{ line: StoredLine; quantity?: number | null; unit?: string | null }> = [];
  if (input.lines === undefined) {
    for (const line of open.filter((candidate) => candidate.checkedAt !== null)) {
      picks.push({ line });
    }
  } else {
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_BATCH) {
      throw new InputError(`lines must hold 1 to ${MAX_BATCH} entries`);
    }
    for (const entry of input.lines as unknown[]) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new InputError("lines entries must be objects");
      }
      const fields = entry as Input;
      requireNoUnknownKeys(fields, new Set(["lineId", "quantity", "unit"]));
      const line = open.find((c) => c.lineId === readUuid(fields, "lineId", { required: true }));
      if (line === undefined) throw new InputError(NO_LIST);
      picks.push({
        line,
        quantity: readQuantity(fields, "quantity"),
        unit: readUnit(fields, "unit")
      });
    }
  }
  if (picks.length === 0) throw new InputError("Tick the lines you bought first");

  const kitchen = await deps.ensureKitchen();
  const actionId = deps.newId();
  const result = await deps.lists.markBought({
    listId: stored.listId,
    kitchenId: kitchen.kitchenId,
    at: deps.now().toISOString(),
    actionId,
    rows: picks.map(({ line, quantity, unit }) => {
      const fallback = line.purchase ?? { quantity: line.quantity, unit: line.unit ?? "" };
      return {
        lineId: line.lineId,
        itemId: deps.newId(),
        name: line.name,
        nameKey: ingredientKey(line.name),
        quantity: quantity !== undefined ? quantity : fallback.quantity,
        unit: (unit !== undefined ? unit : fallback.unit) || null
      };
    })
  });
  return {
    list: await viewOf(deps, await deps.lists.readList()),
    pantryAdded: result.pantryRows,
    undo: { actionId, kind: "bought", count: result.lines }
  };
}

const CLEAR_KEYS = new Set(["listId"]);
export async function listClear(deps: ListDeps, input: Input): Promise<{ cleared: true }> {
  requireNoUnknownKeys(input, CLEAR_KEYS);
  const listId = readUuid(input, "listId", { required: true });
  const stored = await deps.lists.readList();
  if (!stored.exists || stored.listId !== listId)
    throw new InputError("No shopping list with that id");
  await deps.lists.clearLines(listId);
  return { cleared: true };
}

const UNDO_KEYS = new Set(["actionId"]);

function recordLine(record: Record<string, unknown>): StoredLine {
  const purchaseQuantity = record.purchase_quantity as number | null;
  return {
    lineId: record.line_id as string,
    lineKey: (record.line_key as string | null) ?? null,
    manual: record.manual as boolean,
    name: record.name as string,
    quantity: (record.quantity as number | null) ?? null,
    unit: (record.unit as string | null) ?? null,
    purchase:
      purchaseQuantity === null || purchaseQuantity === undefined
        ? null
        : { quantity: purchaseQuantity, unit: (record.purchase_unit as string | null) ?? "" },
    section: record.store_section as StoreSection,
    coveredByPantry: record.covered_by_pantry as boolean,
    notInPlan: record.not_in_plan as boolean,
    convertedFrom: record.converted_from as string[],
    sourceMealIds: record.source_meal_ids as string[],
    checkedAt: (record.checked_at as string | null) ?? null,
    boughtAt: (record.bought_at as string | null) ?? null
  };
}

export async function undo(deps: ListDeps, input: Input): Promise<UndoResult> {
  requireNoUnknownKeys(input, UNDO_KEYS);
  const actionId = readUuid(input, "actionId", { required: true });
  const record = await deps.lists.readUndo(actionId);
  if (record === null || record.undone) throw new InputError("There is nothing to undo");

  if (record.kind === "removed") {
    const stored = await deps.lists.readList();
    const kitchen = await deps.kitchen();
    const lines = (record.state.lines as Record<string, unknown>[]).map(recordLine);
    const restored = await deps.lists.undoRemoved(
      actionId,
      stored.listId,
      kitchen.kitchenId,
      lines
    );
    return { restored, skipped: lines.length - restored };
  }
  if (record.kind === "bought") {
    const state = record.state as { at: string; lineIds: string[]; itemIds: string[] };
    return deps.lists.undoBought(actionId, state.at, state.lineIds, state.itemIds);
  }
  throw new InputError("That action cannot be undone here");
}
