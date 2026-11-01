// external-modules/meals/src/domain/list.ts
//
// Builds shopping lines from a plan's meals and reconciles them against the stored list. Pure.
// A line's identity is its normalised name plus unit family; "other" units also keep their unit,
// so 2 cloves of garlic and 1 head of garlic stay apart.
import type { StoreSection } from "../contracts.js";
import { PACK_SIZES } from "./pack-sizes.js";
import { titleKey } from "./repeats.js";
import { convert, formatNumber, normaliseUnit, unitFamily } from "./units.js";

export interface ListIngredient {
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly section: StoreSection;
}

export interface ListMealInput {
  readonly mealId: string;
  /** Servings the plan cooks, after any override. */
  readonly servings: number;
  readonly baseServings: number;
  readonly ingredients: readonly ListIngredient[];
}

export interface ListBuildInput {
  readonly meals: readonly ListMealInput[];
  /** Name keys the Pantry covers. Their lines are marked, not dropped. Empty until S5. */
  readonly coveredNameKeys?: ReadonlySet<string>;
}

export interface Purchase {
  readonly quantity: number;
  readonly unit: string;
}

export interface GeneratedLine {
  readonly lineKey: string;
  readonly nameKey: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly purchase: Purchase | null;
  readonly section: StoreSection;
  readonly coveredByPantry: boolean;
  readonly convertedFrom: readonly string[];
  readonly sourceMealIds: readonly string[];
}

export interface StoredLine {
  readonly lineId: string;
  readonly lineKey: string | null;
  readonly manual: boolean;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly purchase: Purchase | null;
  readonly section: StoreSection;
  readonly coveredByPantry: boolean;
  readonly notInPlan: boolean;
  readonly convertedFrom: readonly string[];
  readonly sourceMealIds: readonly string[];
  readonly checkedAt: string | null;
  readonly boughtAt: string | null;
}

export interface LineUpdate {
  readonly lineId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly purchase: Purchase | null;
  readonly section: StoreSection;
  readonly coveredByPantry: boolean;
  readonly notInPlan: boolean;
  readonly convertedFrom: readonly string[];
  readonly sourceMealIds: readonly string[];
}

export interface ListDiff {
  readonly insert: readonly GeneratedLine[];
  readonly update: readonly LineUpdate[];
  readonly remove: readonly string[];
}

export const SECTION_ORDER: readonly StoreSection[] = [
  "produce",
  "meat_fish",
  "dairy_eggs",
  "bakery",
  "frozen",
  "pantry",
  "spices",
  "drinks",
  "household",
  "other"
];

const KEY_LENGTH = 80;

export function ingredientKey(name: string): string {
  return titleKey(name).slice(0, KEY_LENGTH).trim() || "item";
}

function lineKeyFor(nameKey: string, unit: string | null): string {
  const family = unitFamily(unit);
  const normal = normaliseUnit(unit);
  return family === "other" ? `${nameKey}|other:${normal}` : `${nameKey}|${family}`;
}

interface Entry {
  readonly name: string;
  readonly section: StoreSection;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly mealId: string;
}

function mergeGroup(
  lineKey: string,
  nameKey: string,
  entries: readonly Entry[],
  covered: boolean
): GeneratedLine {
  const first = entries[0]!;
  const quantified = entries.filter((entry) => entry.quantity !== null);
  const sourceMealIds = [...new Set(entries.map((entry) => entry.mealId))];
  const section = entries.find((entry) => entry.section !== "other")?.section ?? first.section;
  const base = { lineKey, nameKey, name: first.name, section, sourceMealIds };

  if (quantified.length === 0) {
    return {
      ...base,
      quantity: null,
      unit: normaliseUnit(first.unit),
      purchase: null,
      coveredByPantry: covered,
      convertedFrom: []
    };
  }

  const target = normaliseUnit(quantified[0]!.unit);
  let total = 0;
  const convertedFrom: string[] = [];
  for (const entry of quantified) {
    const unit = normaliseUnit(entry.unit);
    if (unit === target || target === null || unit === null) {
      total += entry.quantity!;
      continue;
    }
    total += convert(entry.quantity!, unit, target) ?? entry.quantity!;
    convertedFrom.push(`${formatNumber(entry.quantity!)} ${unit}`);
  }
  const quantity = Math.round(total * 1000) / 1000;
  const line = { ...base, quantity, unit: target, coveredByPantry: covered, convertedFrom };
  return { ...line, purchase: purchaseAmount(line) };
}

/** Merges every meal's ingredients into lines, scaled to the servings and grouped by section. */
export function buildList(input: ListBuildInput): readonly GeneratedLine[] {
  const groups = new Map<string, { nameKey: string; entries: Entry[] }>();
  for (const meal of input.meals) {
    const scale = meal.baseServings > 0 ? meal.servings / meal.baseServings : 1;
    for (const ingredient of meal.ingredients) {
      const nameKey = ingredientKey(ingredient.name);
      const lineKey = lineKeyFor(nameKey, ingredient.unit);
      const group = groups.get(lineKey) ?? { nameKey, entries: [] };
      group.entries.push({
        name: ingredient.name,
        section: ingredient.section,
        quantity: ingredient.quantity === null ? null : ingredient.quantity * scale,
        unit: ingredient.unit,
        mealId: meal.mealId
      });
      groups.set(lineKey, group);
    }
  }
  const lines = [...groups].map(([lineKey, group]) =>
    mergeGroup(
      lineKey,
      group.nameKey,
      group.entries,
      input.coveredNameKeys?.has(group.nameKey) ?? false
    )
  );
  return lines.sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) ||
      a.name.localeCompare(b.name)
  );
}

/**
 * The amount to buy. Packaged names round up to the smallest pack that covers the need, or to
 * whole copies of the largest pack. Anything else buys the raw amount, with counts rounded up.
 */
export function purchaseAmount(
  line: Pick<GeneratedLine, "nameKey" | "quantity" | "unit">
): Purchase | null {
  if (line.quantity === null) return null;
  const unit = normaliseUnit(line.unit);
  const packs = PACK_SIZES[line.nameKey];
  if (packs !== undefined && unit !== null) {
    const fits = packs
      .map((pack) => ({ pack, need: convert(line.quantity!, unit, pack.unit) }))
      .filter(
        (entry): entry is { pack: (typeof packs)[number]; need: number } => entry.need !== null
      );
    if (fits.length > 0) {
      const covering = fits.find((entry) => entry.pack.quantity >= entry.need - 1e-9);
      if (covering) return { quantity: covering.pack.quantity, unit: covering.pack.unit };
      const largest = fits[fits.length - 1]!;
      return {
        quantity: Math.ceil(largest.need / largest.pack.quantity - 1e-9) * largest.pack.quantity,
        unit: largest.pack.unit
      };
    }
  }
  if (unit === null) return { quantity: Math.ceil(line.quantity - 1e-9), unit: "" };
  return { quantity: line.quantity, unit };
}

function samePurchase(a: Purchase | null, b: Purchase | null): boolean {
  return a === b || (a !== null && b !== null && a.quantity === b.quantity && a.unit === b.unit);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Rebuilds the stored list from freshly generated lines without deleting what a shopper has
 * touched. Matching lines update in place, so ticks carry over. Manual and bought lines are left
 * alone. A ticked line that left the plan stays and is marked not in plan; an unticked one goes.
 */
export function reconcileList(
  stored: readonly StoredLine[],
  generated: readonly GeneratedLine[]
): ListDiff {
  const open = stored.filter((line) => !line.manual && line.boughtAt === null);
  const byKey = new Map(open.map((line) => [line.lineKey, line]));
  const seen = new Set<string>();
  const insert: GeneratedLine[] = [];
  const update: LineUpdate[] = [];

  for (const line of generated) {
    const match = byKey.get(line.lineKey);
    if (!match) {
      insert.push(line);
      continue;
    }
    seen.add(line.lineKey);
    // An amount the shopper edited stays until the recipes' need itself changes.
    const needSame = match.quantity === line.quantity && match.unit === line.unit;
    const purchase = needSame ? match.purchase : line.purchase;
    const unchanged =
      match.name === line.name &&
      needSame &&
      samePurchase(match.purchase, purchase) &&
      match.section === line.section &&
      match.coveredByPantry === line.coveredByPantry &&
      !match.notInPlan &&
      sameList(match.convertedFrom, line.convertedFrom) &&
      sameList(match.sourceMealIds, line.sourceMealIds);
    if (unchanged) continue;
    update.push({
      lineId: match.lineId,
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      purchase,
      section: line.section,
      coveredByPantry: line.coveredByPantry,
      notInPlan: false,
      convertedFrom: line.convertedFrom,
      sourceMealIds: line.sourceMealIds
    });
  }

  const remove: string[] = [];
  for (const line of open) {
    if (seen.has(line.lineKey!)) continue;
    if (line.checkedAt === null) {
      remove.push(line.lineId);
    } else if (!line.notInPlan) {
      update.push({
        lineId: line.lineId,
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        purchase: line.purchase,
        section: line.section,
        coveredByPantry: line.coveredByPantry,
        notInPlan: true,
        convertedFrom: line.convertedFrom,
        sourceMealIds: []
      });
    }
  }
  return { insert, update, remove };
}
