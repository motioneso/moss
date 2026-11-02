// external-modules/meals/src/domain/cooking.ts
//
// Pure rules for Mark cooked: how much of each Pantry item a meal uses, and the servings step.
import { isStaple, namesMatch, type PantryInput } from "./pantry.js";
import { convert, normaliseUnit } from "./units.js";

export interface CookedLine {
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
}

export interface CookedStock {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
}

export interface PantryChange {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string | null;
  readonly before: number;
  readonly after: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Servings move in halves, between 0.5 and 24. */
export function validServings(value: number): boolean {
  return (
    Number.isFinite(value) && value >= 0.5 && value <= 24 && value * 2 === Math.floor(value * 2)
  );
}

/**
 * What cooking takes out of the Pantry. Each ingredient is scaled by `scale`, skips Staples and
 * lines with no amount, and draws from matching rows that have an amount in a convertible unit.
 * A row never goes below zero, and a row with no amount ("have some") is left alone.
 */
export function pantrySubtraction(
  lines: readonly CookedLine[],
  scale: number,
  stock: readonly CookedStock[],
  staples: PantryInput
): PantryChange[] {
  const remaining = new Map(stock.map((row) => [row.itemId, row.quantity]));
  const touched = new Map<string, PantryChange>();
  for (const line of lines) {
    if (line.quantity === null || isStaple(line.name, staples)) continue;
    const target = normaliseUnit(line.unit);
    let need = line.quantity * scale;
    for (const row of stock) {
      if (need <= 1e-9) break;
      const have = remaining.get(row.itemId);
      if (have === null || have === undefined || have <= 0) continue;
      if (!namesMatch(row.name, line.name)) continue;
      const from = normaliseUnit(row.unit);
      let needInRow: number | null;
      if (from === target) needInRow = need;
      else if (from !== null && target !== null) needInRow = convert(need, target, from);
      else needInRow = null;
      if (needInRow === null) continue;
      const used = Math.min(have, needInRow);
      const left = round(have - used);
      remaining.set(row.itemId, left);
      need -= from === target ? used : (convert(used, from!, target!) ?? 0);
      const first = touched.get(row.itemId);
      touched.set(row.itemId, {
        itemId: row.itemId,
        name: row.name,
        unit: row.unit,
        before: first?.before ?? have,
        after: left
      });
    }
  }
  return [...touched.values()];
}
