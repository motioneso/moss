// external-modules/meals/src/ai/recipe.ts
//
// Model job 1: write one recipe to a schema. The schema, the prompt with one worked example, and
// the boundary validator. Eaters are numbered, never named, so no household names reach a prompt.

import type { StoreSection, UnitsSystem } from "../contracts.js";
import type { IngredientDraft } from "../domain/safety.js";

export interface RecipeEater {
  /** This eater's calorie share for the meal, or null without a target. */
  readonly shareKcal: number | null;
  readonly restrictions: readonly string[];
  readonly preferences: readonly string[];
}

export interface RecipeRequest {
  readonly slotName: string;
  readonly date: string;
  readonly eaters: readonly RecipeEater[];
  readonly cookTimeLimitMinutes: number | null;
  /** The person's own words from the plan request, verbatim. */
  readonly requestText: string | null;
  readonly avoidTitles: readonly string[];
  readonly unitsSystem: UnitsSystem;
}

export interface RecipeDraft {
  readonly title: string;
  readonly steps: readonly string[];
  readonly cookMinutes: number;
  readonly baseServings: number;
  readonly ingredients: readonly IngredientDraft[];
}

export const STORE_SECTIONS: readonly StoreSection[] = [
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

const MAX_AVOID_TITLES = 60;
const MAX_INGREDIENTS = 40;
const MAX_STEPS = 30;
const MAX_STEP_LENGTH = 600;

export const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "cookMinutes", "baseServings", "steps", "ingredients"],
  properties: {
    title: { type: "string", description: "Short dish name, at most 120 characters." },
    cookMinutes: {
      type: "integer",
      description: "Total active and passive time from start to plate, in minutes."
    },
    baseServings: {
      type: "number",
      description: "How many standard servings the ingredient amounts make."
    },
    steps: {
      type: "array",
      description: "Method, one instruction per entry, in order. 1 to 30 entries.",
      items: { type: "string", description: "One instruction." }
    },
    ingredients: {
      type: "array",
      description: "Every ingredient, including oil, salt and water. 1 to 40 entries.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["originalText", "name", "quantity", "unit", "section", "checkLabel"],
        properties: {
          originalText: {
            type: "string",
            description: 'The full line as a cook reads it, for example "2 tbsp olive oil".'
          },
          name: { type: "string", description: 'The food alone, for example "olive oil".' },
          quantity: {
            type: ["number", "null"],
            description: "Amount for the base servings, or null for to-taste items."
          },
          unit: {
            type: ["string", "null"],
            description: 'Unit of the quantity, for example "g", "cup" or "tbsp". Null for a count.'
          },
          section: {
            type: "string",
            enum: STORE_SECTIONS,
            description: "Store section where a shopper finds it."
          },
          checkLabel: {
            type: "boolean",
            description: "True for a packaged or branded product whose label should be checked."
          }
        }
      }
    }
  }
} as const;

/** Rules are quoted so a diet word reads as a diet to follow, not as a food to leave out. */
export function quotedRules(restrictions: readonly string[]): string {
  return restrictions.map((rule) => JSON.stringify(rule)).join(", ");
}

function eaterLine(eater: RecipeEater, index: number): string {
  const parts = [`Eater ${index + 1}:`];
  parts.push(
    eater.restrictions.length > 0
      ? `must follow ${quotedRules(eater.restrictions)}`
      : "no restrictions"
  );
  if (eater.preferences.length > 0) parts.push(`prefers ${eater.preferences.join(", ")}`);
  if (eater.shareKcal !== null) parts.push(`about ${eater.shareKcal} kcal for this meal`);
  return parts.join("; ");
}

export function buildRecipePrompt(request: RecipeRequest): string {
  const avoid = request.avoidTitles.slice(-MAX_AVOID_TITLES);
  const lines = [
    "Write one home-cooked recipe for the meal below, for every eater listed.",
    'Each eater\'s rules name foods they cannot eat, or a diet such as "vegetarian" whose excluded foods they cannot eat.',
    "Never use an ingredient any eater's rules exclude, including in sauces, stocks and garnishes.",
    "Set checkLabel on any packaged or branded product.",
    `Use ${request.unitsSystem === "metric" ? "metric" : "US"} units.`,
    "",
    'Example: dinner for one eater who never eats peanuts -> title "Chicken and broccoli stir-fry", ' +
      "cookMinutes 25, baseServings 2, ingredients include " +
      '{originalText "2 tbsp soy sauce", name "soy sauce", quantity 2, unit "tbsp", section "pantry", checkLabel true}.',
    "",
    `Meal: ${request.slotName} on ${request.date}`,
    ...request.eaters.map(eaterLine),
    request.cookTimeLimitMinutes !== null
      ? `Must be ready in ${request.cookTimeLimitMinutes} minutes or less.`
      : "",
    avoid.length > 0 ? `Do not repeat any of these dishes: ${avoid.join("; ")}` : "",
    request.requestText ? `The household asked: ${request.requestText}` : ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function fail(message: string): never {
  throw new Error(`recipe: ${message}`);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) fail(`${field} must be 1 to ${max} characters`);
  return text;
}

function onlyKnownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  at: string
): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) fail(`unexpected field ${at}${key}`);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseIngredient(raw: unknown, index: number): IngredientDraft {
  const at = `ingredients[${index}]`;
  const record = asRecord(raw, at);
  onlyKnownKeys(
    record,
    ["originalText", "name", "quantity", "unit", "section", "checkLabel"],
    `${at}.`
  );
  const quantity = record["quantity"];
  // The column keeps three decimals, so anything under 0.001 would store as 0.
  if (
    quantity !== null &&
    (typeof quantity !== "number" || !(quantity >= 0.001) || quantity > 1e6)
  ) {
    fail(`${at}.quantity must be at least 0.001, or null`);
  }
  const unit = record["unit"] === null ? null : boundedString(record["unit"], `${at}.unit`, 24);
  const section = record["section"];
  if (!STORE_SECTIONS.includes(section as StoreSection)) fail(`${at}.section is unknown`);
  if (typeof record["checkLabel"] !== "boolean") fail(`${at}.checkLabel must be a boolean`);
  return {
    originalText: boundedString(record["originalText"], `${at}.originalText`, 200),
    name: boundedString(record["name"], `${at}.name`, 80),
    quantity: quantity as number | null,
    unit,
    section: section as StoreSection,
    checkLabel: record["checkLabel"]
  };
}

/** Throws on any shape or range the tables would refuse, or a cook time over the night's limit. */
export function parseRecipe(
  raw: unknown,
  limits: { readonly cookTimeLimitMinutes: number | null }
): RecipeDraft {
  const record = asRecord(raw, "recipe");
  onlyKnownKeys(record, ["title", "cookMinutes", "baseServings", "steps", "ingredients"], "");

  const cookMinutes = record["cookMinutes"];
  if (typeof cookMinutes !== "number" || !Number.isInteger(cookMinutes)) {
    fail("cookMinutes must be an integer");
  }
  if (cookMinutes < 1 || cookMinutes > 600) fail("cookMinutes must be 1 to 600");
  if (limits.cookTimeLimitMinutes !== null && cookMinutes > limits.cookTimeLimitMinutes) {
    fail("cookMinutes is over the cook-time limit");
  }

  const servings = record["baseServings"];
  if (typeof servings !== "number" || !Number.isFinite(servings)) {
    fail("baseServings must be a number");
  }
  const baseServings = Math.round(servings * 2) / 2;
  if (baseServings < 0.5 || baseServings > 24) fail("baseServings must be 0.5 to 24");

  const steps = record["steps"];
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
    fail(`steps must hold 1 to ${MAX_STEPS} entries`);
  }
  const ingredients = record["ingredients"];
  if (
    !Array.isArray(ingredients) ||
    ingredients.length < 1 ||
    ingredients.length > MAX_INGREDIENTS
  ) {
    fail(`ingredients must hold 1 to ${MAX_INGREDIENTS} entries`);
  }

  return {
    title: boundedString(record["title"], "title", 120),
    steps: steps.map((step, index) => boundedString(step, `steps[${index}]`, MAX_STEP_LENGTH)),
    cookMinutes,
    baseServings,
    ingredients: ingredients.map(parseIngredient)
  };
}
