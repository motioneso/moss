// external-modules/meals/src/domain/pantry.ts
//
// Pure Pantry rules: when a Pantry or Staple name covers an ingredient, how much stock covers a
// need, and whether a recipe cooks only from what is on hand.
import type { PantryMode } from "../contracts.js";
import { titleKey } from "./repeats.js";
import { convert, normaliseUnit } from "./units.js";

/** One Pantry row as the list build and the recipe check read it. */
export interface PantryStock {
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
}

export interface PantryInput {
  readonly mode: PantryMode;
  readonly stock: readonly PantryStock[];
  /** Staple names. They are on hand in every mode. */
  readonly staples: readonly string[];
}

/** Always on hand. */
const FREE = new Set(["water", "ice"]);

/** Folds a simple English plural to its singular. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(ch|sh|[sxo])es$/.test(word)) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const words = (name: string): string[] => titleKey(name).split(" ").filter(Boolean);

/**
 * Words that describe the state or kind of a food without making it a different food. They may
 * be dropped before names are compared. Any other extra word makes a different food.
 */
const DESCRIPTORS = new Set([
  "fresh",
  "dried",
  "dry",
  "ground",
  "organic",
  "large",
  "small",
  "medium",
  "raw",
  "ripe",
  "frozen",
  "chopped",
  "sliced",
  "minced",
  "plain",
  "basmati",
  "jasmine",
  "long",
  "grain"
]);

function core(name: string): string[] {
  const all = words(name).map(singular);
  const kept = all.filter((word) => !DESCRIPTORS.has(word));
  return kept.length > 0 ? kept : all;
}

/**
 * True when two names are the same food. The names must be equal after folding plurals and
 * dropping descriptor words, so "rice" matches "Basmati rice" and "tomatoes" matches "tomato",
 * while "milk" does not match "coconut milk", "pepper" does not match "bell pepper", and "rice"
 * does not match "rice vinegar".
 */
export function namesMatch(a: string, b: string): boolean {
  const left = core(a);
  const right = core(b);
  if (left.length === 0 || right.length === 0) return false;
  return left.length === right.length && left.every((word, i) => word === right[i]);
}

export function isStaple(name: string, input: PantryInput): boolean {
  return (
    FREE.has(words(name).join(" ")) || input.staples.some((staple) => namesMatch(staple, name))
  );
}

export type Coverage =
  /** The Pantry has all of it, or has some with no amount recorded. */
  | { readonly kind: "covered" }
  /** The Pantry has part of it. `need` is what is still missing, in the line's unit. */
  | { readonly kind: "partial"; readonly need: number }
  | { readonly kind: "none" };

/** How the Pantry stock covers a need of `quantity` `unit` of `name`. */
export function coverage(
  name: string,
  quantity: number | null,
  unit: string | null,
  stock: readonly PantryStock[]
): Coverage {
  const matches = stock.filter((row) => namesMatch(row.name, name));
  if (matches.length === 0) return { kind: "none" };
  if (quantity === null || matches.some((row) => row.quantity === null)) {
    return { kind: "covered" };
  }
  const target = normaliseUnit(unit);
  let have = 0;
  for (const row of matches) {
    const from = normaliseUnit(row.unit);
    if (from === target) have += row.quantity!;
    else if (from !== null && target !== null) have += convert(row.quantity!, from, target) ?? 0;
  }
  if (have <= 0) return { kind: "none" };
  if (have >= quantity - 1e-9) return { kind: "covered" };
  return { kind: "partial", need: Math.round((quantity - have) * 1000) / 1000 };
}

/** Names of the recipe's ingredients that neither the Pantry nor the Staples cover. */
export function offPantry(
  ingredients: readonly { readonly name: string }[],
  input: PantryInput
): string[] {
  return ingredients
    .filter(
      (ingredient) =>
        !isStaple(ingredient.name, input) &&
        !input.stock.some((row) => namesMatch(row.name, ingredient.name))
    )
    .map((ingredient) => ingredient.name);
}
