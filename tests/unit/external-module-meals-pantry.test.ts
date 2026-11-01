// tests/unit/external-module-meals-pantry.test.ts
//
// Meals phase 2 slice 5 (#3889): Pantry name matching, subtraction on list build in each mode,
// Staples, and the "cook only from what I have" check.

import { describe, expect, it } from "vitest";

import { buildList, type ListIngredient } from "../../external-modules/meals/src/domain/list.js";
import {
  coverage,
  namesMatch,
  offPantry,
  type PantryInput
} from "../../external-modules/meals/src/domain/pantry.js";

const ing = (name: string, quantity: number | null, unit: string | null): ListIngredient => ({
  name,
  quantity,
  unit,
  section: "pantry"
});
const meal = (ingredients: ListIngredient[]) => ({
  mealId: "m1",
  servings: 2,
  baseServings: 2,
  ingredients
});
const pantry = (
  mode: PantryInput["mode"],
  stock: PantryInput["stock"],
  staples: string[] = []
): PantryInput => ({ mode, stock, staples });

describe("name matching", () => {
  it("matches a plain name to a longer one that ends the same way", () => {
    expect(namesMatch("rice", "basmati rice")).toBe(true);
    expect(namesMatch("basmati rice", "rice")).toBe(true);
  });

  it("folds plurals and ignores descriptor words", () => {
    expect(namesMatch("tomatoes", "tomato")).toBe(true);
    expect(namesMatch("fresh basil", "basil")).toBe(true);
    expect(namesMatch("berries", "berry")).toBe(true);
  });

  it("does not match a different food that adds a word", () => {
    expect(namesMatch("milk", "coconut milk")).toBe(false);
    expect(namesMatch("pepper", "bell pepper")).toBe(false);
    expect(namesMatch("butter", "peanut butter")).toBe(false);
    expect(namesMatch("coconut milk", "milk")).toBe(false);
  });

  it("does not match a different food that contains the word", () => {
    expect(namesMatch("rice", "rice vinegar")).toBe(false);
    expect(namesMatch("onion", "onion powder")).toBe(false);
  });
});

describe("coverage", () => {
  it("treats a Pantry row with no amount as enough", () => {
    const stock = [{ name: "Flour", quantity: null, unit: null }];
    expect(coverage("flour", 500, "g", stock)).toEqual({ kind: "covered" });
  });

  it("subtracts a partial amount and converts units", () => {
    const stock = [{ name: "Flour", quantity: 0.2, unit: "kg" }];
    const result = coverage("flour", 500, "g", stock);
    expect(result.kind).toBe("partial");
    expect(result.kind === "partial" ? result.need : 0).toBeCloseTo(300, 3);
  });

  it("does not subtract across units that cannot convert", () => {
    const stock = [{ name: "Flour", quantity: 2, unit: "cup" }];
    expect(coverage("flour", 500, "g", stock).kind).toBe("none");
  });
});

describe("list build by Pantry mode", () => {
  const meals = [meal([ing("Rice", 300, "g"), ing("Lentils", 200, "g"), ing("Salt", 1, "tsp")])];
  const stock = [
    { name: "Rice", quantity: 1, unit: "kg" },
    { name: "Lentils", quantity: 50, unit: "g" }
  ];

  it("ignore lists everything and subtracts nothing", () => {
    const lines = buildList({ meals, pantry: pantry("ignore", stock, ["Salt"]) });
    const by = Object.fromEntries(lines.map((l) => [l.name, l]));
    expect(Object.keys(by).sort()).toEqual(["Lentils", "Rice"]);
    expect(by.Rice!.coveredByPantry).toBe(false);
    expect(by.Lentils!.quantity).toBe(200);
  });

  it("prefer covers what is enough, shrinks what is partial, and drops Staples", () => {
    const lines = buildList({ meals, pantry: pantry("prefer", stock, ["Salt"]) });
    const by = Object.fromEntries(lines.map((l) => [l.name, l]));
    expect(by.Rice!.coveredByPantry).toBe(true);
    expect(by.Lentils!.coveredByPantry).toBe(false);
    expect(by.Lentils!.quantity).toBeCloseTo(150, 3);
    expect(by.Salt).toBeUndefined();
  });

  it("only subtracts the same way, so a meal cooked from stock lists nothing to buy", () => {
    const lines = buildList({
      meals: [meal([ing("Rice", 300, "g"), ing("Salt", 1, "tsp")])],
      pantry: pantry("only", stock, ["Salt"])
    });
    expect(lines.filter((l) => !l.coveredByPantry)).toEqual([]);
  });
});

describe("cook only from what I have", () => {
  const input = pantry("only", [{ name: "Rice", quantity: null, unit: null }], ["Salt"]);

  it("reports ingredients that are neither in the Pantry nor Staples", () => {
    const off = offPantry(
      [ing("Basmati rice", 1, "cup"), ing("Salt", 1, "tsp"), ing("Saffron", 1, null)],
      input
    );
    expect(off).toEqual(["Saffron"]);
  });

  it("treats water and ice as always on hand", () => {
    expect(offPantry([ing("Water", 1, "cup"), ing("Ice", 1, null)], input)).toEqual([]);
  });
});
