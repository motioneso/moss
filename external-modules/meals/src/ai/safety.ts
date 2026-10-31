// external-modules/meals/src/ai/safety.ts
//
// Model job 2: judge Safety for each eater. The model can only add a failure. mergeSafety in
// domain/safety.ts enforces that, so this file only shapes the call and validates the answer.

import type { SafetyVerdict } from "../domain/safety.js";
import type { RecipeDraft } from "./recipe.js";

const FALLBACK_REASON = "Flagged by the safety check";
const MISSING_REASON = "The safety check gave no answer for this eater";
const MAX_REASON = 200;

export const SAFETY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["eaters"],
  properties: {
    eaters: {
      type: "array",
      description: "One verdict per eater listed in the prompt.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["eater", "verdict", "reason"],
        properties: {
          eater: { type: "integer", description: "The eater's number from the prompt." },
          verdict: {
            type: "string",
            enum: ["pass", "fail"],
            description: '"fail" if any ingredient may break this eater\'s Never serve list.'
          },
          reason: {
            type: ["string", "null"],
            description: "For a fail, the ingredient and the rule it breaks. Null for a pass."
          }
        }
      }
    }
  }
} as const;

export function buildSafetyPrompt(
  recipe: RecipeDraft,
  eaters: readonly { readonly restrictions: readonly string[] }[]
): string {
  const lines = [
    "Check one recipe against each eater's Never serve list.",
    "Fail an eater when any ingredient is, contains, or is commonly made with something on their list. " +
      "Hidden sources count: stocks, sauces, pastes and garnishes. When unsure, fail.",
    "",
    'Example: eater 1 never eats fish; ingredient "1 tbsp Thai red curry paste" -> ' +
      '{eater 1, verdict "fail", reason "Red curry paste often contains shrimp paste"}.',
    "",
    `Recipe: ${recipe.title}`,
    ...recipe.ingredients.map((line) => `- ${line.originalText}`),
    ...eaters.map(
      (eater, index) =>
        `Eater ${index + 1} never serve: ${eater.restrictions.length > 0 ? eater.restrictions.join(", ") : "nothing"}`
    )
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * One verdict per eater, in prompt order. An eater the answer leaves out fails, because the
 * check fails closed. Throws on a malformed answer.
 */
export function parseSafety(raw: unknown, eaterCount: number): readonly SafetyVerdict[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("safety: answer must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "eaters") throw new Error(`safety: unexpected field ${key}`);
  }
  const entries = record["eaters"];
  if (!Array.isArray(entries)) throw new Error("safety: eaters must be an array");

  const verdicts: (SafetyVerdict | null)[] = Array.from({ length: eaterCount }, () => null);
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") throw new Error("safety: bad entry");
    const { eater, verdict, reason } = entry as Record<string, unknown>;
    if (verdict !== "pass" && verdict !== "fail") throw new Error("safety: bad verdict");
    if (typeof eater !== "number" || !Number.isInteger(eater)) continue;
    const index = eater - 1;
    if (index < 0 || index >= eaterCount) continue;
    if (verdict === "pass") {
      if (verdicts[index]?.verdict !== "fail") verdicts[index] = { verdict: "pass" };
      continue;
    }
    const text =
      typeof reason === "string" && reason.trim() !== "" ? reason.trim() : FALLBACK_REASON;
    verdicts[index] = { verdict: "fail", reason: text.slice(0, MAX_REASON) };
  }
  return verdicts.map((verdict) => verdict ?? { verdict: "fail", reason: MISSING_REASON });
}
