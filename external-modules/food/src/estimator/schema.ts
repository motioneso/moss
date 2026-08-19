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
  required: [
    "outcome",
    "caloriesKcal",
    "proteinG",
    "carbohydratesG",
    "fatG",
    "fiberG",
    "sugarG",
    "sodiumMg",
    "missingDetails",
    "clarificationQuestion"
  ],
  properties: {
    outcome: {
      type: "string",
      enum: ["estimated", "needs_details"],
      description:
        '"estimated" if the description names real food with enough sense of amount to guess ' +
        'nutrition; "needs_details" if it is too vague to estimate even roughly (no food named, ' +
        "or food named with no sense of portion)."
    },
    caloriesKcal: {
      type: ["number", "null"],
      description:
        "Total energy for this ONE meal, in kilocalories (kcal). Null when outcome is needs_details."
    },
    proteinG: {
      type: ["number", "null"],
      description: "Protein for this one meal, in grams (g). Null when outcome is needs_details."
    },
    carbohydratesG: {
      type: ["number", "null"],
      description:
        "Total carbohydrates for this one meal, in grams (g). Null when outcome is needs_details."
    },
    fatG: {
      type: ["number", "null"],
      description: "Total fat for this one meal, in grams (g). Null when outcome is needs_details."
    },
    fiberG: {
      type: ["number", "null"],
      description:
        "Dietary fiber for this one meal, in grams (g). Null when outcome is needs_details."
    },
    sugarG: {
      type: ["number", "null"],
      description:
        "Total sugar for this one meal, in grams (g). Null when outcome is needs_details."
    },
    sodiumMg: {
      type: ["number", "null"],
      description:
        "Sodium for this one meal, in milligrams (mg). Null when outcome is needs_details."
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
    'If it names real food with a rough sense of amount, return outcome "estimated" with your ' +
      "best-guess value for every nutrient field, in the units the schema field descriptions name.",
    'If it is too vague to estimate even roughly, return outcome "needs_details", leave every ' +
      "nutrient field null, and ask one short clarifying question.",
    "",
    'Example: "a bowl of oatmeal with a banana" -> outcome "estimated", caloriesKcal 350, ' +
      "proteinG 10, carbohydratesG 65, fatG 6, fiberG 8, sugarG 20, sodiumMg 150.",
    "",
    `Meal description: ${description}`,
    servingNote ? `Serving note: ${servingNote}` : ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}

export interface ParsedEstimateResult {
  readonly outcome: "estimated" | "needs_details";
  /** Raw, still-untrusted nutrient values — validateNutrients (guard 3) runs on this in run.ts. */
  readonly nutrientFields: Record<string, unknown>;
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
  ...NUTRIENT_FIELD_NAMES,
  "missingDetails",
  "clarificationQuestion"
]);

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
  const nutrientFields: Record<string, unknown> = {};
  for (const field of NUTRIENT_FIELD_NAMES) nutrientFields[field] = record[field];
  return { outcome, nutrientFields, missingDetails, clarificationQuestion };
}
