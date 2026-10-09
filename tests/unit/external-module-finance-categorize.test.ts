// tests/unit/external-module-finance-categorize.test.ts
import { describe, expect, it } from "vitest";

import { categorize, decideReview } from "../../external-modules/finance/src/domain/categorize.js";
import type {
  AiTxInput,
  ReviewPolicy,
  Rule
} from "../../external-modules/finance/src/domain/categorize.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/index.js";
import { DEFAULT_CATEGORIES, PFC_MAP } from "../../external-modules/finance/src/domain/taxonomy.js";
import { buildCategorizeAi } from "../../external-modules/finance/src/worker/ai-port.js";
import type { FinanceAiInput } from "../../external-modules/finance/src/worker/ports.js";

// FIN-02 (#1147) Task 9: the categorization pipeline. PURE apart from the
// injected ai callback: precedence is rule → PFC map → AI, user-categorized
// records are never touched, and AI is best-effort only — a null port, a
// thrown call, or a bogus category id must never block the sync that carries
// the records.

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    accountId: "acc-1",
    date: "2026-07-10",
    amountCents: 1234,
    isoCurrency: "USD",
    name: "ACME",
    merchant: null,
    plaidCategory: null,
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    ...over
  };
}

const ASK: ReviewPolicy = {
  sortingTier: "ask_each_time",
  sortingNewTier: "ask_each_time",
  seenPayeeKeys: new Set()
};

const RULES: Rule[] = [
  { payeeKey: "trader joes", categoryId: "groceries", createdAt: "2026-07-01T00:00:00Z" }
];

describe("finance categorization pipeline (#1147)", () => {
  it("applies precedence: rule beats PFC map beats AI", async () => {
    const calls: AiTxInput[][] = [];
    const ai = async (batch: AiTxInput[]) => {
      calls.push(batch);
      return { "t-ai": { categoryId: "entertainment", confidence: 0.9 } };
    };
    const result = await categorize(
      [
        // Rule match AND a mappable Plaid category: the rule must win.
        tx({ id: "t-rule", name: "TRADER JOE'S #123", plaidCategory: "GENERAL_MERCHANDISE" }),
        tx({ id: "t-pfc", name: "Some Diner", plaidCategory: "FOOD_AND_DRINK" }),
        tx({ id: "t-ai", name: "Mystery Vendor" })
      ],
      RULES,
      [...DEFAULT_CATEGORIES],
      ai,
      ASK
    );
    const byId = Object.fromEntries(result.map((record) => [record.id, record]));
    expect(byId["t-rule"]).toMatchObject({ categoryId: "groceries", categorizedBy: "rule" });
    expect(byId["t-pfc"]).toMatchObject({ categoryId: "dining", categorizedBy: "plaid-map" });
    expect(byId["t-ai"]).toMatchObject({ categoryId: "entertainment", categorizedBy: "ai" });
    // Only the record neither stage could place reaches the AI.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((item) => item.id)).toEqual(["t-ai"]);
  });

  it("never touches user-categorized or already-categorized records", async () => {
    const calls: AiTxInput[][] = [];
    const ai = async (batch: AiTxInput[]) => {
      calls.push(batch);
      return {};
    };
    const user = tx({
      id: "t-user",
      name: "TRADER JOE'S #9",
      categoryId: "dining",
      categorizedBy: "user"
    });
    const prior = tx({ id: "t-prior", categoryId: "transport", categorizedBy: "ai" });
    const result = await categorize([user, prior], RULES, [...DEFAULT_CATEGORIES], ai, ASK);
    expect(result.find((record) => record.id === "t-user")).toEqual(user);
    expect(result.find((record) => record.id === "t-prior")).toEqual(prior);
    expect(calls).toHaveLength(0);
  });

  it("chunks AI batches at 40 and sends payee/amount/date only", async () => {
    const calls: Array<{ batch: AiTxInput[]; categoryIds: string[] }> = [];
    const ai = async (batch: AiTxInput[], categoryIds: string[]) => {
      calls.push({ batch, categoryIds });
      return {};
    };
    const records = Array.from({ length: 85 }, (_, index) =>
      tx({ id: `t-${index}`, name: `Vendor ${index}`, notes: "PRIVATE NOTE" })
    );
    await categorize(records, [], [...DEFAULT_CATEGORIES], ai, ASK);
    expect(calls.map((call) => call.batch.length)).toEqual([40, 40, 5]);
    // The AI input surface is a hard privacy boundary: id for correlation,
    // then payee/amount/date — never notes, merchant, or account ids.
    for (const call of calls) {
      for (const item of call.batch) {
        expect(Object.keys(item).sort()).toEqual(["amountCents", "date", "id", "payee"]);
      }
      expect(call.categoryIds).toEqual(DEFAULT_CATEGORIES.map((category) => category.id));
    }
  });

  it("leaves records uncategorized when the AI callback throws", async () => {
    const result = await categorize(
      [tx({ id: "t-1" }), tx({ id: "t-2", plaidCategory: "TRAVEL" })],
      [],
      [...DEFAULT_CATEGORIES],
      async () => {
        throw new Error("provider_error");
      },
      ASK
    );
    const byId = Object.fromEntries(result.map((record) => [record.id, record]));
    // The mapped record is still applied — AI failure only affects its batch.
    expect(byId["t-2"]).toMatchObject({ categoryId: "travel", categorizedBy: "plaid-map" });
    expect(byId["t-1"]).toMatchObject({ categoryId: null, categorizedBy: null });
  });

  it("leaves records uncategorized when no AI port exists", async () => {
    const result = await categorize([tx({ id: "t-1" })], [], [...DEFAULT_CATEGORIES], null, ASK);
    expect(result[0]).toMatchObject({ categoryId: null, categorizedBy: null });
  });

  it("drops unknown category ids returned by the AI", async () => {
    const result = await categorize(
      [tx({ id: "t-1" }), tx({ id: "t-2" })],
      [],
      [...DEFAULT_CATEGORIES],
      async () => ({
        "t-1": { categoryId: "not-a-category", confidence: 0.9 },
        "t-2": { categoryId: "dining", confidence: 0.9 }
      }),
      ASK
    );
    const byId = Object.fromEntries(result.map((record) => [record.id, record]));
    expect(byId["t-1"]).toMatchObject({ categoryId: null, categorizedBy: null });
    expect(byId["t-2"]).toMatchObject({ categoryId: "dining", categorizedBy: "ai" });
  });

  it("bridge asks ctx.ai for a schema-constrained id map on the economy tier", async () => {
    const inputs: FinanceAiInput[] = [];
    const call = buildCategorizeAi({
      generateStructured: async (input) => {
        inputs.push(input);
        return {
          ok: true,
          object: {
            "t-1": { categoryId: "dining", confidence: 0.8 },
            "t-2": 42,
            "t-3": { categoryId: "travel", confidence: 7 }
          }
        };
      }
    })!;
    const result = await call(
      [{ id: "t-1", payee: "Corner Bakery", amountCents: 850, date: "2026-07-02" }],
      ["dining", "travel"]
    );
    // Malformed guesses are dropped at the bridge and an out-of-range
    // confidence reads as 0; id validation happens in the pipeline (single
    // place for the unknown-id rule).
    expect(result).toEqual({
      "t-1": { categoryId: "dining", confidence: 0.8 },
      "t-3": { categoryId: "travel", confidence: 0 }
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.tierHint).toBe("economy");
    expect(inputs[0]!.prompt).toContain("Corner Bakery");
    // The schema constrains every value to the live category ids.
    expect(JSON.stringify(inputs[0]!.schema)).toContain('"dining","travel"');
  });

  it("bridge degrades to an empty map on a failed or malformed AI result", async () => {
    const failed = buildCategorizeAi({
      generateStructured: async () => ({ ok: false, error: "provider_error" })
    })!;
    expect(await failed([], ["dining"])).toEqual({});
    const malformed = buildCategorizeAi({
      generateStructured: async () => ({ ok: true, object: "dining" })
    })!;
    expect(await malformed([], ["dining"])).toEqual({});
    expect(buildCategorizeAi(null)).toBeNull();
  });

  it("seed taxonomy covers every PFC map target with unique live ids", () => {
    const ids = DEFAULT_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of DEFAULT_CATEGORIES) expect(category.archived).toBe(false);
    for (const [pfc, categoryId] of Object.entries(PFC_MAP)) {
      expect(ids, `PFC_MAP[${pfc}]`).toContain(categoryId);
    }
  });

  it("decideReview covers every row of the spec table", () => {
    const tiers = ["ask_each_time", "trusted_auto"] as const;
    for (const sortingTier of tiers) {
      for (const sortingNewTier of tiers) {
        const policy = { sortingTier, sortingNewTier };
        // Payee rule: always confirmed.
        for (const seen of [true, false]) {
          expect(decideReview({ source: "rule", seen, confidence: null, policy })).toBe(
            "confirmed"
          );
        }
        // Seen merchant follows the sorting tier; new merchant follows sorting_new.
        for (const source of ["plaid-map", "ai"] as const) {
          const confidence = source === "ai" ? 0.9 : null;
          expect(decideReview({ source, seen: true, confidence, policy })).toBe(
            sortingTier === "trusted_auto" ? "confirmed" : "needs_look"
          );
          expect(decideReview({ source, seen: false, confidence, policy })).toBe(
            sortingNewTier === "trusted_auto" ? "confirmed" : "needs_look"
          );
        }
        // AI under 0.6 needs a look whatever the tiers say.
        for (const seen of [true, false]) {
          expect(decideReview({ source: "ai", seen, confidence: 0.59, policy })).toBe("needs_look");
          expect(decideReview({ source: "ai", seen, confidence: 0.6, policy })).toBe(
            (seen ? sortingTier : sortingNewTier) === "trusted_auto" ? "confirmed" : "needs_look"
          );
        }
      }
    }
    // A tier that is not trusted_auto never lets Moss confirm.
    expect(
      decideReview({
        source: "plaid-map",
        seen: true,
        confidence: null,
        policy: { sortingTier: "always_confirm", sortingNewTier: "always_confirm" }
      })
    ).toBe("needs_look");
  });

  it("applies the table end to end and stores the AI confidence", async () => {
    const policy: ReviewPolicy = {
      sortingTier: "trusted_auto",
      sortingNewTier: "ask_each_time",
      seenPayeeKeys: new Set(["known cafe"])
    };
    const result = await categorize(
      [
        tx({ id: "t-rule", name: "TRADER JOE'S #1" }),
        tx({ id: "t-seen", name: "Known Cafe 22" }),
        tx({ id: "t-new", name: "Brand New Place" }),
        tx({ id: "t-low", name: "Known Cafe 23" })
      ],
      RULES,
      [...DEFAULT_CATEGORIES],
      async (batch) =>
        Object.fromEntries(
          batch.map((item) => [
            item.id,
            { categoryId: "dining", confidence: item.id === "t-low" ? 0.3 : 0.95 }
          ])
        ),
      policy
    );
    const byId = Object.fromEntries(result.map((record) => [record.id, record]));
    expect(byId["t-rule"]).toMatchObject({ reviewState: "confirmed", aiConfidence: null });
    expect(byId["t-seen"]).toMatchObject({ reviewState: "confirmed", aiConfidence: 0.95 });
    expect(byId["t-new"]).toMatchObject({ reviewState: "needs_look", aiConfidence: 0.95 });
    expect(byId["t-low"]).toMatchObject({ reviewState: "needs_look", aiConfidence: 0.3 });
  });

  it("a Plaid-map result for a new merchant needs a look when sorting_new asks", async () => {
    const result = await categorize(
      [tx({ id: "t-1", name: "Some Diner", plaidCategory: "FOOD_AND_DRINK" })],
      [],
      [...DEFAULT_CATEGORIES],
      null,
      ASK
    );
    expect(result[0]).toMatchObject({
      categoryId: "dining",
      reviewState: "needs_look",
      aiConfidence: null
    });
  });

  it("a merchant Moss just confirmed counts as seen later in the same run", async () => {
    const policy: ReviewPolicy = {
      sortingTier: "ask_each_time",
      sortingNewTier: "trusted_auto",
      seenPayeeKeys: new Set()
    };
    const result = await categorize(
      [
        tx({ id: "t-1", name: "Fresh Bakery", plaidCategory: "FOOD_AND_DRINK" }),
        tx({ id: "t-2", name: "Fresh Bakery", plaidCategory: "FOOD_AND_DRINK" })
      ],
      [],
      [...DEFAULT_CATEGORIES],
      null,
      policy
    );
    // First is new (sorting_new trusted -> confirmed); second is now seen and
    // the sorting tier asks.
    expect(result.map((record) => record.reviewState)).toEqual(["confirmed", "needs_look"]);
  });
});

describe("rows nothing could place (review finding 2)", () => {
  it("marks an unplaced row as needing a look, with and without an AI port", async () => {
    const records = [tx({ id: "t-x", name: "Mystery Vendor" })];
    const noAi = await categorize(records, [], [...DEFAULT_CATEGORIES], null, ASK);
    expect(noAi[0]).toMatchObject({ categoryId: null, reviewState: "needs_look" });
    const emptyAi = await categorize(records, [], [...DEFAULT_CATEGORIES], async () => ({}), ASK);
    expect(emptyAi[0]).toMatchObject({ categoryId: null, reviewState: "needs_look" });
  });

  it("marks a row whose AI guess names an unknown category as needing a look", async () => {
    const result = await categorize(
      [tx({ id: "t-y", name: "Mystery Vendor" })],
      [],
      [...DEFAULT_CATEGORIES],
      async () => ({ "t-y": { categoryId: "nope", confidence: 0.99 } }),
      ASK
    );
    expect(result[0]).toMatchObject({ categoryId: null, reviewState: "needs_look" });
  });
});
