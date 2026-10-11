// external-modules/finance/src/worker/ai-port.ts
//
// FIN-02 (#1147) Task 9: bridge from the structural ctx.ai port (ports.ts,
// job-search ai-port pattern) to the pipeline's CategorizeAi callback. The
// prompt carries id/payee/amount/date ONLY (AiTxInput is the privacy
// boundary), the schema pins every value to the live category ids, and any
// failure degrades to an empty map — categorization is best-effort by design.
import type { AiGuess, AiTxInput, CategorizeAi } from "../domain/index.js";
import type { FinanceAi } from "./ports.js";

export function buildCategorizeAi(ai: FinanceAi | null): CategorizeAi | null {
  if (ai === null) return null;
  return async (batch: AiTxInput[], categoryIds: string[]) => {
    const result = await ai.generateStructured({
      schema: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            categoryId: { type: "string", enum: categoryIds },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          },
          required: ["categoryId", "confidence"]
        }
      },
      prompt: [
        "Assign a budget category to each personal bank transaction below.",
        `Valid category ids: ${categoryIds.join(", ")}.`,
        "Respond with a JSON object mapping each transaction id to an object",
        "with categoryId (one valid category id) and confidence (0 to 1, how",
        "sure you are). Omit any transaction you cannot place at all.",
        `Transactions: ${JSON.stringify(batch)}`
      ].join("\n"),
      maxOutputTokens: 2000,
      tierHint: "economy"
    });
    if (!result.ok || typeof result.object !== "object" || result.object === null) return {};
    const out: Record<string, AiGuess> = {};
    for (const [txId, guess] of Object.entries(result.object as Record<string, unknown>)) {
      // Malformed guesses are dropped here; unknown-id validation stays in
      // the pipeline so the rule lives in exactly one place. A missing or
      // out-of-range confidence counts as 0, which always needs a look.
      if (typeof guess !== "object" || guess === null) continue;
      const { categoryId, confidence } = guess as Record<string, unknown>;
      if (typeof categoryId !== "string") continue;
      out[txId] = {
        categoryId,
        confidence:
          typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : 0
      };
    }
    return out;
  };
}
