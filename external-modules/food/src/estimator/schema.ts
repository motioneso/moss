// external-modules/food/src/estimator/schema.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 5 + §3 determinism boundary): the
// output schema and prompt handed to ctx.ai.generateStructured, plus the
// parser that turns a validated response into the two things the model is
// allowed to decide (plan §3): "estimated" (with a nutrition guess) or
// "needs_details" (with a bounded clarification question). Everything else
// — which state a meal is IN, how totals are computed, day boundaries — is
// TypeScript over persisted records, never model output (domain/estimate.ts,
// domain/totals.ts, store/sql.ts).
//
// Guard 1 (per-field descriptions naming the canonical unit) lives in
// ESTIMATE_SCHEMA below. Guard 2 (one worked example) lives in
// buildEstimatePrompt. Guard 3 (boundary validator) is
// domain/estimate.ts's validateNutrients, applied in run.ts. Guard 4
// (correction diffing) is store/sql.ts's correctMeal, outside this file.

/**
 * additionalProperties: false is the schema-level half of the "no invented
 * fields" guard — parseEstimateResult below is the second half, so a schema
 * regression that let something extra through still cannot become a row.
 * Every nutrient field carries a description naming its canonical unit
 * (guard 1): the model is never left to guess whether a number means grams
 * or ounces, kcal or kJ.
 */
export const ESTIMATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "items", "missingDetails", "clarificationQuestion"],
  properties: {
    outcome: {
      type: "string",
      enum: ["estimated", "needs_details"],
      description:
        '"estimated" if the description names real food with enough sense of amount to guess ' +
        'nutrition; "needs_details" if it is too vague to estimate even roughly (no food named, ' +
        "or food named with no sense of portion)."
    },
    items: {
      type: "array",
      description:
        "One entry per individual food in the meal, in the order described. A meal of one food " +
        "has one entry. Empty when outcome is needs_details.",
      items: {
        type: "object",
        // Per-ITEM, not just at the top level: a nested schema that only guarded
        // its root would let an invented field ride in on every item.
        additionalProperties: false,
        required: [
          "label",
          "portionNote",
          "caloriesKcal",
          "proteinG",
          "carbohydratesG",
          "fatG",
          "fiberG",
          "sugarG",
          "sodiumMg"
        ],
        properties: {
          label: {
            type: "string",
            description:
              'The food itself, without the amount — "hot wings", "breadsticks", "Coke Zero".'
          },
          portionNote: {
            type: ["string", "null"],
            description:
              'The amount as described, without the food — "6", "32 oz", "1 cup cooked". Null if ' +
              "the description gave no amount for this item."
          },
          caloriesKcal: {
            type: ["number", "null"],
            description:
              "Energy for THIS ITEM only, in kilocalories (kcal). Null if you cannot estimate it."
          },
          proteinG: {
            type: ["number", "null"],
            description: "Protein for this item only, in grams (g). Null if you cannot estimate it."
          },
          carbohydratesG: {
            type: ["number", "null"],
            description:
              "Total carbohydrates for this item only, in grams (g). Null if you cannot estimate it."
          },
          fatG: {
            type: ["number", "null"],
            description:
              "Total fat for this item only, in grams (g). Null if you cannot estimate it."
          },
          fiberG: {
            type: ["number", "null"],
            description:
              "Dietary fiber for this item only, in grams (g). Null if you cannot estimate it."
          },
          sugarG: {
            type: ["number", "null"],
            description:
              "Total sugar for this item only, in grams (g). Null if you cannot estimate it."
          },
          sodiumMg: {
            type: ["number", "null"],
            description:
              "Sodium for this item only, in milligrams (mg). Null if you cannot estimate it."
          }
        }
      }
    },
    missingDetails: {
      type: ["string", "null"],
      description:
        'When outcome is needs_details, a short phrase naming what is missing (e.g. "no portion ' +
        'size"). Null when outcome is estimated.'
    },
    clarificationQuestion: {
      type: ["string", "null"],
      description:
        "When outcome is needs_details, one short question to ask the user that would let you " +
        "estimate. Null when outcome is estimated."
    }
  }
} as const;

/**
 * One line-per-instruction template (job-search buildScorePrompt pattern),
 * joined with newlines, empty lines dropped. `servingNote` is the ONLY
 * optional line — everything else in the template is always present, which
 * is what keeps this well under the plan's guidance budget regardless of
 * description length: the budget bounds the FIXED instruction text, not the
 * user's own words, which the prompt must carry verbatim to be estimated at
 * all.
 *
 * Guard 2 (one worked example) is the "Example:" line — deliberately just
 * one. A second example doubles the fixed cost of every call for the same
 * marginal guidance; if the model needs more than one worked example to
 * behave, per plan §3 the fix is a smaller job for the model, not a longer
 * prompt.
 */
export function buildEstimatePrompt(description: string, servingNote: string | null): string {
  const lines = [
    "Estimate the nutrition in one meal from its plain-text description.",
    "Break the meal into the individual foods it contains, one item per food, and estimate each " +
      "item on its own. Never return one lump figure for the whole meal.",
    'If it names real food with a rough sense of amount, return outcome "estimated" with your ' +
      "best-guess value for every nutrient field of every item, in the units the schema field " +
      "descriptions name.",
    'If it is too vague to estimate even roughly, return outcome "needs_details", an empty items ' +
      "list, and one short clarifying question.",
    "",
    'Example: "a bowl of oatmeal with a banana" -> outcome "estimated", two items: ' +
      '{label "oatmeal", portionNote "1 bowl", caloriesKcal 310, proteinG 8, carbohydratesG 55, ' +
      "fatG 5, fiberG 8, sugarG 2, sodiumMg 140} and " +
      '{label "banana", portionNote "1", caloriesKcal 105, proteinG 1, carbohydratesG 27, ' +
      "fatG 0, fiberG 3, sugarG 14, sodiumMg 1}.",
    "",
    `Meal description: ${description}`,
    servingNote ? `Serving note: ${servingNote}` : ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export interface ParsedEstimateItem {
  readonly label: string;
  readonly portionNote: string | null;
  /** Raw, still-untrusted nutrient values — validateNutrients (guard 3) runs on this in run.ts. */
  readonly nutrientFields: Record<string, unknown>;
}

export interface ParsedEstimateResult {
  readonly outcome: "estimated" | "needs_details";
  readonly items: readonly ParsedEstimateItem[];
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

const NUTRIENT_FIELD_NAMES = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const;

const KNOWN_FIELDS = new Set<string>([
  "outcome",
  "items",
  "missingDetails",
  "clarificationQuestion"
]);

/** Applied per item, not only at the top level — see parseEstimateItem. */
const KNOWN_ITEM_FIELDS = new Set<string>(["label", "portionNote", ...NUTRIENT_FIELD_NAMES]);

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`${field} must be a string or null`);
}

/**
 * Second layer of the "no invented fields" guard (schema `additionalProperties:
 * false` is the first). Throws on anything shaped wrong; never coerces,
 * defaults, or drops a field silently — same discipline as job-search's
 * parseScoreResult/parseCriteria. Nutrient VALUES are deliberately not
 * sanitized here (that is domain/estimate.ts's validateNutrients, guard 3,
 * applied by the caller) — this function only establishes which outcome the
 * model chose and that the two text fields are the right shape.
 */
export function parseEstimateResult(raw: unknown): ParsedEstimateResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("estimate result must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new Error(`unexpected field: ${key}`);
    }
  }
  const outcome = record["outcome"];
  if (outcome !== "estimated" && outcome !== "needs_details") {
    throw new Error('outcome must be "estimated" or "needs_details"');
  }
  const missingDetails = nullableString(record["missingDetails"], "missingDetails");
  const clarificationQuestion = nullableString(
    record["clarificationQuestion"],
    "clarificationQuestion"
  );
  if (outcome === "needs_details" && (!missingDetails || !clarificationQuestion)) {
    throw new Error("needs_details requires non-empty missingDetails and clarificationQuestion");
  }
  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) {
    throw new Error("items must be an array");
  }
  const items = rawItems.map((item, index) => parseEstimateItem(item, index));
  if (outcome === "estimated" && items.length === 0) {
    throw new Error("estimated requires at least one item");
  }
  return { outcome, items, missingDetails, clarificationQuestion };
}

/**
 * The per-item half of the "no invented fields" guard. Applied to every entry,
 * so an extra key on item 3 of 4 fails the whole result rather than riding in
 * on a row. Nutrient VALUES are again left untouched for guard 3.
 */
function parseEstimateItem(raw: unknown, index: number): ParsedEstimateItem {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`items[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_ITEM_FIELDS.has(key)) {
      throw new Error(`unexpected field: items[${index}].${key}`);
    }
  }
  const label = record["label"];
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error(`items[${index}].label must be a non-empty string`);
  }
  const portionNote = nullableString(record["portionNote"], `items[${index}].portionNote`);
  const nutrientFields: Record<string, unknown> = {};
  for (const field of NUTRIENT_FIELD_NAMES) nutrientFields[field] = record[field];
  return { label, portionNote, nutrientFields };
}
