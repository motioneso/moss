// external-modules/meals/src/domain/units.ts
//
// Unit families and conversion. Mass and volume convert within their family. Count (no unit) and
// every other unit word never convert across, so "2 cloves" and "10 g" stay apart.
import type { UnitsSystem } from "../contracts.js";

export type UnitFamily = "mass" | "volume" | "count" | "other";

// Each factor is the size of one unit in grams (mass) or millilitres (volume).
const MASS: Readonly<Record<string, number>> = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592
};
const VOLUME: Readonly<Record<string, number>> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892,
  tbsp: 14.7868,
  "fl oz": 29.5735,
  cup: 236.588,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41
};

const ALIASES: Readonly<Record<string, string>> = {
  gram: "g",
  grams: "g",
  gr: "g",
  kilogram: "kg",
  kilograms: "kg",
  kgs: "kg",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  tbs: "tbsp",
  cups: "cup",
  c: "cup",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  floz: "fl oz",
  pints: "pint",
  pt: "pint",
  quarts: "quart",
  qt: "quart",
  gallons: "gallon",
  gal: "gallon"
};

/** The unit's canonical spelling, or its lowercased trimmed text when it is not a known one. */
export function normaliseUnit(unit: string | null): string | null {
  const text = unit?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (text === "") return null;
  return ALIASES[text] ?? text;
}

export function unitFamily(unit: string | null): UnitFamily {
  const normal = normaliseUnit(unit);
  if (normal === null) return "count";
  if (normal in MASS) return "mass";
  if (normal in VOLUME) return "volume";
  return "other";
}

/** Null when the units are not in one convertible family. */
export function convert(quantity: number, from: string, to: string): number | null {
  const a = normaliseUnit(from);
  const b = normaliseUnit(to);
  if (a === null || b === null) return null;
  if (a === b) return quantity;
  if (a in MASS && b in MASS) return (quantity * MASS[a]!) / MASS[b]!;
  if (a in VOLUME && b in VOLUME) return (quantity * VOLUME[a]!) / VOLUME[b]!;
  return null;
}

const FRACTIONS: ReadonlyArray<[number, string]> = [
  [0.25, "¼"],
  [0.5, "½"],
  [0.75, "¾"]
];

/** A readable number. Quarters read as fractions; anything else rounds to two places. */
export function formatNumber(value: number, fractions = true): string {
  if (!fractions) return String(value >= 10 ? Math.round(value) : Math.round(value * 100) / 100);
  const whole = Math.floor(value + 1e-9);
  const rest = value - whole;
  for (const [fraction, glyph] of FRACTIONS) {
    if (Math.abs(rest - fraction) < 0.02) return whole === 0 ? glyph : `${whole}${glyph}`;
  }
  return String(value >= 10 ? Math.round(value) : Math.round(value * 100) / 100);
}

/**
 * The amount as the kitchen reads it. Metric kitchens see grams and millilitres; US kitchens see
 * pounds, ounces and cups. Spoons and unknown units keep their own unit.
 */
export function kitchenDisplay(
  quantity: number | null,
  unit: string | null,
  system: UnitsSystem
): string | null {
  if (quantity === null) return null;
  const num = (value: number) => formatNumber(value, system === "us");
  const normal = normaliseUnit(unit);
  const family = unitFamily(unit);
  if (normal === null) return num(quantity);
  if (family === "mass") {
    const grams = convert(quantity, normal, "g")!;
    if (system === "metric") {
      return grams >= 1000 ? `${num(grams / 1000)} kg` : `${num(grams)} g`;
    }
    return grams >= 453.592 ? `${num(grams / 453.592)} lb` : `${num(grams / 28.3495)} oz`;
  }
  if (family === "volume" && normal !== "tsp" && normal !== "tbsp") {
    const ml = convert(quantity, normal, "ml")!;
    if (system === "metric") {
      return ml >= 1000 ? `${num(ml / 1000)} l` : `${num(ml)} ml`;
    }
    return ml >= 59 ? `${num(ml / 236.588)} cup` : `${num(ml / 29.5735)} fl oz`;
  }
  return `${num(quantity)} ${normal}`;
}
