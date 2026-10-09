// external-modules/finance/src/domain/categorize.ts
//
// FIN-02 (#1147) Task 9: the categorization pipeline. PURE apart from the
// injected ai callback so it unit-tests without a worker context. Precedence
// per uncategorized record: payee rule → PFC map → AI. AI is strictly
// best-effort: a null port, a thrown call, or an unknown category id leaves
// the record uncategorized — categorization must never block the sync run
// that carries the records (they land in the feed either way).
import { normalizePayee } from "./keys.js";
import type { ReviewState, TransactionRecord } from "./records.js";
import type { Category } from "./taxonomy.js";
import { PFC_MAP } from "./taxonomy.js";

export type Rule = { payeeKey: string; categoryId: string; createdAt: string };

/**
 * The AI input surface is a hard privacy boundary: id (for correlating the
 * response), payee, amount, date — never notes, merchant enrichments, or
 * account ids. Keep this type closed; adding a field here widens what leaves
 * the machine in prompts.
 */
export type AiTxInput = { id: string; payee: string; amountCents: number; date: string };

/** One AI guess: a category id from the closed list plus a 0 to 1 confidence. */
export type AiGuess = { categoryId: string; confidence: number };

export type CategorizeAi = (
  batch: AiTxInput[],
  categoryIds: string[]
) => Promise<Record<string, AiGuess>>;

/** The user's tier for a sorting family; only "trusted_auto" lets Moss confirm. */
export type SortingTier = "ask_each_time" | "trusted_auto" | "always_confirm";

/** AI guesses below this confidence always need a look. */
export const AI_CONFIDENCE_FLOOR = 0.6;

export type ReviewPolicy = {
  /** Tier of the `sorting` family (merchants already confirmed once). */
  sortingTier: SortingTier;
  /** Tier of the `sorting_new` family (first time a merchant appears). */
  sortingNewTier: SortingTier;
  /** normalizePayee keys of merchants with confirmed, categorized history. */
  seenPayeeKeys: ReadonlySet<string>;
};

/**
 * The review-state table from the Finance R1 spec. A payee rule always
 * confirms. Plaid-map and AI results confirm only when the tier for their
 * family (seen merchant: sorting, new merchant: sorting_new) is trusted_auto,
 * and an AI guess under the confidence floor always needs a look.
 */
export function decideReview(input: {
  source: "rule" | "plaid-map" | "ai";
  seen: boolean;
  confidence: number | null;
  policy: Pick<ReviewPolicy, "sortingTier" | "sortingNewTier">;
}): ReviewState {
  if (input.source === "rule") return "confirmed";
  if (
    input.source === "ai" &&
    (input.confidence === null || input.confidence < AI_CONFIDENCE_FLOOR)
  ) {
    return "needs_look";
  }
  const tier = input.seen ? input.policy.sortingTier : input.policy.sortingNewTier;
  return tier === "trusted_auto" ? "confirmed" : "needs_look";
}

/** Plaid batches at count:100; 40 keeps prompts small on economy-tier models. */
const AI_BATCH_SIZE = 40;

export async function categorize(
  records: TransactionRecord[],
  rules: Rule[],
  categories: Category[],
  ai: CategorizeAi | null,
  review: ReviewPolicy
): Promise<TransactionRecord[]> {
  const seen = new Set(review.seenPayeeKeys);
  const decide = (
    record: TransactionRecord,
    source: "rule" | "plaid-map" | "ai",
    confidence: number | null
  ): ReviewState => {
    const key = normalizePayee(record.name);
    const state = decideReview({ source, seen: seen.has(key), confidence, policy: review });
    // A merchant Moss just confirmed counts as seen for the rest of this run.
    if (state === "confirmed") seen.add(key);
    return state;
  };
  const ruleByPayee = new Map(rules.map((rule) => [rule.payeeKey, rule.categoryId]));
  const liveIds = categories.filter((entry) => !entry.archived).map((entry) => entry.id);
  const liveIdSet = new Set(liveIds);

  const out: TransactionRecord[] = [];
  const pendingAi: TransactionRecord[] = [];
  for (const record of records) {
    // Anything already placed — by the user, or by an earlier pipeline run —
    // is settled; re-running categorize over a chunk must be idempotent.
    if (record.categoryId !== null || record.categorizedBy !== null) {
      out.push(record);
      continue;
    }
    const ruleCategory = ruleByPayee.get(normalizePayee(record.name));
    if (ruleCategory !== undefined) {
      out.push({
        ...record,
        categoryId: ruleCategory,
        categorizedBy: "rule",
        reviewState: decide(record, "rule", null),
        aiConfidence: null
      });
      continue;
    }
    const mapped = record.plaidCategory === null ? undefined : PFC_MAP[record.plaidCategory];
    if (mapped !== undefined) {
      out.push({
        ...record,
        categoryId: mapped,
        categorizedBy: "plaid-map",
        reviewState: decide(record, "plaid-map", null),
        aiConfidence: null
      });
      continue;
    }
    out.push(record);
    pendingAi.push(record);
  }

  if (ai === null || pendingAi.length === 0) return out;

  const assigned = new Map<string, AiGuess>();
  for (let start = 0; start < pendingAi.length; start += AI_BATCH_SIZE) {
    const batch = pendingAi.slice(start, start + AI_BATCH_SIZE).map((record) => ({
      id: record.id,
      payee: record.name,
      amountCents: record.amountCents,
      date: record.date
    }));
    try {
      const result = await ai(batch, liveIds);
      for (const [txId, guess] of Object.entries(result)) {
        // Unknown/archived ids are dropped, not "closest-matched": a wrong
        // auto-category is worse than an uncategorized row the user can fix.
        if (liveIdSet.has(guess.categoryId)) assigned.set(txId, guess);
      }
    } catch {
      // This batch stays uncategorized; later batches still get their shot.
    }
  }
  if (assigned.size === 0) return out;
  return out.map((record) => {
    const guess = assigned.get(record.id);
    if (guess === undefined || record.categoryId !== null) return record;
    return {
      ...record,
      categoryId: guess.categoryId,
      categorizedBy: "ai",
      reviewState: decide(record, "ai", guess.confidence),
      aiConfidence: guess.confidence
    };
  });
}
