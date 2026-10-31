// tests/unit/external-module-meals-ai.test.ts
//
// Meals phase 2 slice 2 (#3886): the boundary validators for model output, the prompt budget,
// and the copied estimator's calories per serving.

import { describe, expect, it } from "vitest";

import type { MealsAi } from "../../external-modules/meals/src/ai/port.js";
import {
  buildRecipePrompt,
  parseRecipe,
  RECIPE_SCHEMA,
  type RecipeDraft
} from "../../external-modules/meals/src/ai/recipe.js";
import {
  buildSafetyPrompt,
  parseSafety,
  SAFETY_SCHEMA
} from "../../external-modules/meals/src/ai/safety.js";
import { estimateKcalPerServing } from "../../external-modules/meals/src/estimator/recipe-kcal.js";

function rawRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Lentil and spinach dal",
    cookMinutes: 35,
    baseServings: 4,
    steps: ["Rinse the lentils.", "Simmer with spices for 25 minutes.", "Stir in spinach."],
    ingredients: [
      {
        originalText: "1 cup red lentils",
        name: "red lentils",
        quantity: 1,
        unit: "cup",
        section: "pantry",
        checkLabel: false
      },
      {
        originalText: "1 can coconut milk",
        name: "coconut milk",
        quantity: 1,
        unit: "can",
        section: "pantry",
        checkLabel: true
      }
    ],
    ...overrides
  };
}

const NO_LIMIT = { cookTimeLimitMinutes: null };

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

describe("parseRecipe", () => {
  it("accepts a well-formed recipe", () => {
    const recipe = parseRecipe(rawRecipe(), NO_LIMIT);
    expect(recipe.title).toBe("Lentil and spinach dal");
    expect(recipe.ingredients).toHaveLength(2);
    expect(recipe.ingredients[1]?.checkLabel).toBe(true);
  });

  it("rejects an invented field at the top and on an ingredient", () => {
    expect(() => parseRecipe(rawRecipe({ calories: 400 }), NO_LIMIT)).toThrow();
    const ingredients = [{ ...(rawRecipe().ingredients as object[])[0], brand: "Acme" }];
    expect(() => parseRecipe(rawRecipe({ ingredients }), NO_LIMIT)).toThrow();
  });

  it("rejects a quantity too small for the table's three decimals", () => {
    const ingredients = [{ ...(rawRecipe().ingredients as object[])[0], quantity: 0.0004 }];
    expect(() => parseRecipe(rawRecipe({ ingredients }), NO_LIMIT)).toThrow(/quantity/);
  });

  it("rejects values outside the table limits", () => {
    expect(() => parseRecipe(rawRecipe({ title: "x".repeat(121) }), NO_LIMIT)).toThrow();
    expect(() => parseRecipe(rawRecipe({ steps: [] }), NO_LIMIT)).toThrow();
    expect(() => parseRecipe(rawRecipe({ baseServings: 0 }), NO_LIMIT)).toThrow();
    expect(() => parseRecipe(rawRecipe({ cookMinutes: 0 }), NO_LIMIT)).toThrow();
    const badSection = [{ ...(rawRecipe().ingredients as object[])[0], section: "aisle 9" }];
    expect(() => parseRecipe(rawRecipe({ ingredients: badSection }), NO_LIMIT)).toThrow();
  });

  it("rejects a recipe over the night's cook-time limit", () => {
    expect(() =>
      parseRecipe(rawRecipe({ cookMinutes: 35 }), { cookTimeLimitMinutes: 20 })
    ).toThrow();
    expect(
      parseRecipe(rawRecipe({ cookMinutes: 20 }), { cookTimeLimitMinutes: 20 }).cookMinutes
    ).toBe(20);
  });

  it("rounds base servings to halves", () => {
    expect(parseRecipe(rawRecipe({ baseServings: 2.3 }), NO_LIMIT).baseServings).toBe(2.5);
  });
});

describe("parseSafety", () => {
  it("maps each verdict to its eater and ignores an unknown eater number", () => {
    const verdicts = parseSafety(
      {
        eaters: [
          { eater: 2, verdict: "fail", reason: "Fish sauce is not vegetarian" },
          { eater: 1, verdict: "pass", reason: null },
          { eater: 7, verdict: "fail", reason: "Nobody" }
        ]
      },
      2
    );
    expect(verdicts).toEqual([
      { verdict: "pass" },
      { verdict: "fail", reason: "Fish sauce is not vegetarian" }
    ]);
  });

  it("fails an eater the answer leaves out, and gives a bare failure a reason", () => {
    const verdicts = parseSafety({ eaters: [{ eater: 1, verdict: "fail", reason: null }] }, 2);
    expect(verdicts[0]).toMatchObject({ verdict: "fail" });
    expect((verdicts[0] as { reason: string }).reason.length).toBeGreaterThan(0);
    expect(verdicts[1]).toMatchObject({ verdict: "fail", reason: expect.any(String) });
  });

  it("fails every eater when the answer lists none", () => {
    expect(parseSafety({ eaters: [] }, 2).map((verdict) => verdict.verdict)).toEqual([
      "fail",
      "fail"
    ]);
  });

  it("rejects a malformed answer", () => {
    expect(() => parseSafety({ eaters: "all fine" }, 1)).toThrow();
    expect(() => parseSafety({ eaters: [], extra: true }, 1)).toThrow();
  });
});

describe("schemas and prompts", () => {
  it("describes every schema field", () => {
    const undescribed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const properties = record["properties"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      for (const [key, child] of Object.entries(properties ?? {})) {
        if (typeof child["description"] !== "string") undescribed.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
      walk(record["items"], `${path}[]`);
    };
    walk(RECIPE_SCHEMA, "recipe");
    walk(SAFETY_SCHEMA, "safety");
    expect(undescribed).toEqual([]);
  });

  it("keeps the fixed prompt text under 150 words", () => {
    const recipePrompt = buildRecipePrompt({
      slotName: "",
      date: "",
      eaters: [],
      cookTimeLimitMinutes: null,
      requestText: null,
      avoidTitles: [],
      unitsSystem: "us"
    });
    const recipe: RecipeDraft = {
      title: "",
      steps: [],
      cookMinutes: 1,
      baseServings: 1,
      ingredients: []
    };
    expect(wordCount(recipePrompt)).toBeLessThan(150);
    expect(wordCount(buildSafetyPrompt(recipe, []))).toBeLessThan(150);
  });

  // Live on moss-proof, "never serve vegetarian" read as "serve no vegetarian food": every
  // shared meal for a vegetarian eater came back with meat.
  it("gives a diet word as a rule to follow, never as a food to avoid", () => {
    const rules = ["vegetarian", "no peanuts"];
    const recipePrompt = buildRecipePrompt({
      slotName: "dinner",
      date: "2026-11-02",
      eaters: [{ shareKcal: null, restrictions: rules, preferences: [] }],
      cookTimeLimitMinutes: null,
      requestText: null,
      avoidTitles: [],
      unitsSystem: "us"
    });
    const safetyPrompt = buildSafetyPrompt(parseRecipe(rawRecipe(), NO_LIMIT), [
      { restrictions: rules }
    ]);
    for (const prompt of [recipePrompt, safetyPrompt]) {
      expect(prompt).not.toMatch(/never serve:? vegetarian/i);
      expect(prompt).toContain('must follow "vegetarian", "no peanuts"');
    }
  });
});

describe("calories per serving", () => {
  const recipe = (): RecipeDraft => parseRecipe(rawRecipe(), NO_LIMIT);

  function scriptedAi(answer: unknown): MealsAi {
    return {
      generateStructured: async () =>
        answer instanceof Error
          ? { ok: false, error: "provider_error" }
          : { ok: true, object: answer }
    };
  }

  const item = (kcal: number | null) => ({
    label: "food",
    portionNote: null,
    caloriesKcal: kcal,
    proteinG: null,
    carbohydratesG: null,
    fatG: null,
    fiberG: null,
    sugarG: null,
    sodiumMg: null
  });

  it("divides the whole recipe's estimate by its servings", async () => {
    const ai = scriptedAi({
      outcome: "estimated",
      items: [item(1200), item(800)],
      missingDetails: null,
      clarificationQuestion: null
    });
    await expect(estimateKcalPerServing(ai, recipe())).resolves.toBe(500);
  });

  it("asks for the economy tier", async () => {
    const hints: (string | undefined)[] = [];
    const ai: MealsAi = {
      generateStructured: async (input) => {
        hints.push(input.tierHint);
        return { ok: false, error: "provider_error" };
      }
    };
    await estimateKcalPerServing(ai, recipe());
    expect(hints).toEqual(["economy"]);
  });

  it("is unknown when the estimate fails", async () => {
    await expect(estimateKcalPerServing(scriptedAi(new Error()), recipe())).resolves.toBeNull();
    const vague = scriptedAi({
      outcome: "estimated",
      items: [item(null)],
      missingDetails: null,
      clarificationQuestion: null
    });
    await expect(estimateKcalPerServing(vague, recipe())).resolves.toBeNull();
  });
});
