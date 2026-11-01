// tests/unit/external-module-meals-list.test.ts
//
// Meals phase 2 slice 4 (#3888): units, merging, purchase rounding and the rebuild rules.

import { describe, expect, it } from "vitest";

import {
  buildList,
  ingredientKey,
  purchaseAmount,
  reconcileList,
  type GeneratedLine,
  type ListIngredient,
  type StoredLine
} from "../../external-modules/meals/src/domain/list.js";
import {
  convert,
  kitchenDisplay,
  unitFamily
} from "../../external-modules/meals/src/domain/units.js";

const ing = (
  name: string,
  quantity: number | null,
  unit: string | null,
  section: ListIngredient["section"] = "pantry"
): ListIngredient => ({ name, quantity, unit, section });

const meal = (mealId: string, ingredients: ListIngredient[], servings = 2, baseServings = 2) => ({
  mealId,
  servings,
  baseServings,
  ingredients
});

describe("units", () => {
  it("sorts units into families", () => {
    expect(unitFamily("g")).toBe("mass");
    expect(unitFamily("Cups")).toBe("volume");
    expect(unitFamily(null)).toBe("count");
    expect(unitFamily("cloves")).toBe("other");
  });

  it("converts inside a family and refuses across families", () => {
    expect(convert(1, "cup", "ml")).toBeCloseTo(236.588, 2);
    expect(convert(1, "kg", "g")).toBe(1000);
    expect(convert(1, "g", "ml")).toBeNull();
    expect(convert(2, "clove", "g")).toBeNull();
  });

  it("shows amounts in the kitchen's own system", () => {
    expect(kitchenDisplay(500, "g", "metric")).toBe("500 g");
    expect(kitchenDisplay(500, "g", "us")).toBe("1.1 lb");
    expect(kitchenDisplay(236.588, "ml", "us")).toBe("1 cup");
    expect(kitchenDisplay(1500, "ml", "metric")).toBe("1.5 l");
    expect(kitchenDisplay(1.5, "tsp", "us")).toBe("1½ tsp");
    expect(kitchenDisplay(3, null, "us")).toBe("3");
    expect(kitchenDisplay(null, "g", "us")).toBeNull();
  });
});

describe("buildList", () => {
  it("merges 1 cup and 200 ml into one line and records the conversion", () => {
    const lines = buildList({
      meals: [
        meal("m1", [ing("Milk", 1, "cup", "dairy_eggs")]),
        meal("m2", [ing("milk", 200, "ml", "dairy_eggs")])
      ]
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.unit).toBe("cup");
    expect(lines[0]!.quantity).toBeCloseTo(1 + 200 / 236.588, 2);
    expect(lines[0]!.convertedFrom).toEqual(["200 ml"]);
    expect(lines[0]!.sourceMealIds).toEqual(["m1", "m2"]);
  });

  it("keeps 2 cloves and 10 g of garlic apart", () => {
    const lines = buildList({
      meals: [meal("m1", [ing("Garlic", 2, "cloves"), ing("Garlic", 10, "g")])]
    });
    expect(lines.map((line) => line.unit).sort()).toEqual(["cloves", "g"]);
  });

  it("scales amounts by the servings", () => {
    const [line] = buildList({ meals: [meal("m1", [ing("Rice", 100, "g")], 6, 2)] });
    expect(line!.quantity).toBe(300);
  });

  it("lists each source meal once and groups lines by store section", () => {
    const lines = buildList({
      meals: [
        meal("m1", [ing("Salt", 1, "tsp", "spices"), ing("Tomato", 2, null, "produce")]),
        meal("m2", [ing("Tomato", 1, null, "produce")])
      ]
    });
    expect(lines.map((line) => line.section)).toEqual(["produce", "spices"]);
    expect(lines[0]!.quantity).toBe(3);
    expect(lines[0]!.sourceMealIds).toEqual(["m1", "m2"]);
  });

  it("marks lines the Pantry covers instead of dropping them", () => {
    const [line] = buildList({
      meals: [meal("m1", [ing("Rice", 100, "g")])],
      coveredNameKeys: new Set(["rice"])
    });
    expect(line!.coveredByPantry).toBe(true);
  });
});

describe("purchaseAmount", () => {
  const line = (name: string, quantity: number | null, unit: string | null) => ({
    nameKey: ingredientKey(name),
    quantity,
    unit
  });

  it("rounds up to the smallest pack that covers the need", () => {
    expect(purchaseAmount(line("Milk", 300, "ml"))).toEqual({ quantity: 500, unit: "ml" });
    expect(purchaseAmount(line("Milk", 1, "cup"))).toEqual({ quantity: 500, unit: "ml" });
    expect(purchaseAmount(line("Milk", 700, "ml"))).toEqual({ quantity: 1000, unit: "ml" });
  });

  it("buys whole copies of the largest pack when one is not enough", () => {
    expect(purchaseAmount(line("Milk", 2500, "ml"))).toEqual({ quantity: 4000, unit: "ml" });
  });

  it("buys the raw amount when the name has no pack, and rounds counts up", () => {
    expect(purchaseAmount(line("Saffron", 2, "g"))).toEqual({ quantity: 2, unit: "g" });
    expect(purchaseAmount(line("Onion", 2.5, null))).toEqual({ quantity: 3, unit: "" });
    expect(purchaseAmount(line("Salt", null, null))).toBeNull();
  });
});

describe("reconcileList (U1)", () => {
  const generated = (
    name: string,
    quantity: number | null,
    unit: string | null,
    extra: Partial<GeneratedLine> = {}
  ): GeneratedLine => {
    const [line] = buildList({ meals: [meal("m1", [ing(name, quantity, unit)])] });
    return { ...line!, ...extra };
  };

  const stored = (line: GeneratedLine, extra: Partial<StoredLine> = {}): StoredLine => ({
    lineId: `id-${line.lineKey}`,
    lineKey: line.lineKey,
    manual: false,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    purchase: line.purchase,
    section: line.section,
    coveredByPantry: false,
    notInPlan: false,
    convertedFrom: line.convertedFrom,
    sourceMealIds: line.sourceMealIds,
    checkedAt: null,
    boughtAt: null,
    ...extra
  });

  it("changes nothing when the plan did not change", () => {
    const rice = generated("Rice", 100, "g");
    const diff = reconcileList([stored(rice, { checkedAt: "2026-11-01T10:00:00Z" })], [rice]);
    expect(diff).toEqual({ insert: [], update: [], remove: [] });
  });

  it("updates a ticked line in place when its amount changed, so the tick survives", () => {
    const before = generated("Rice", 100, "g");
    const after = generated("Rice", 200, "g");
    const row = stored(before, { checkedAt: "2026-11-01T10:00:00Z" });
    const diff = reconcileList([row], [after]);
    expect(diff.remove).toEqual([]);
    expect(diff.insert).toEqual([]);
    expect(diff.update).toHaveLength(1);
    expect(diff.update[0]).toMatchObject({ lineId: row.lineId, quantity: 200 });
  });

  it("keeps a ticked line that left the plan and marks it not in plan", () => {
    const rice = generated("Rice", 100, "g");
    const diff = reconcileList([stored(rice, { checkedAt: "2026-11-01T10:00:00Z" })], []);
    expect(diff.remove).toEqual([]);
    expect(diff.update[0]).toMatchObject({ lineId: `id-${rice.lineKey}`, notInPlan: true });
  });

  it("removes an unticked line that left the plan", () => {
    const rice = generated("Rice", 100, "g");
    expect(reconcileList([stored(rice)], []).remove).toEqual([`id-${rice.lineKey}`]);
  });

  it("leaves manual lines and bought lines alone and inserts new lines", () => {
    const rice = generated("Rice", 100, "g");
    const manual = stored(rice, { lineId: "own", lineKey: null, manual: true });
    const bought = stored(rice, { lineId: "done", boughtAt: "2026-11-01T10:00:00Z" });
    const pasta = generated("Pasta", 200, "g");
    const diff = reconcileList([manual, bought], [rice, pasta]);
    expect(diff.remove).toEqual([]);
    expect(diff.update).toEqual([]);
    expect(diff.insert.map((line) => line.name)).toEqual(["Rice", "Pasta"]);
  });

  it("keeps an amount the shopper edited while the recipes' need is unchanged", () => {
    const flour = generated("Flour", 300, "g");
    const edited = stored(flour, { purchase: { quantity: 2000, unit: "g" } });
    expect(reconcileList([edited], [flour])).toEqual({ insert: [], update: [], remove: [] });
    const more = generated("Flour", 900, "g");
    expect(reconcileList([edited], [more]).update[0]!.purchase).toEqual(more.purchase);
  });
});
