// tests/unit/external-module-meals-domain.test.ts
//
// Meals phase 2 slice 2 (#3886): the pure planning rules. Skeleton, calorie split and fit,
// deterministic Safety, the brand rule and the no-repeat rule.

import { describe, expect, it } from "vitest";

import type { KitchenView, MemberView } from "../../external-modules/meals/src/contracts.js";
import {
  applyBrandRule,
  brandRule,
  deterministicSafety,
  mergeSafety,
  type IngredientDraft
} from "../../external-modules/meals/src/domain/safety.js";
import { isRepeat, titleKey } from "../../external-modules/meals/src/domain/repeats.js";
import { planSkeleton } from "../../external-modules/meals/src/domain/skeleton.js";
import {
  calorieFit,
  mealShareKcal,
  portionFor
} from "../../external-modules/meals/src/domain/targets.js";

function member(overrides: Partial<MemberView> & { memberId: string }): MemberView {
  return {
    name: overrides.memberId,
    isSelf: false,
    linkedAccountEmail: null,
    calorieTarget: null,
    macroTargets: { proteinG: null, carbG: null, fatG: null },
    mealPattern: ["breakfast", "lunch", "dinner"],
    restrictions: [],
    preferences: [],
    favouriteRecipeIds: [],
    ...overrides
  };
}

function kitchen(members: readonly MemberView[], slotRules: KitchenView["slotRules"] = []) {
  return {
    kitchenId: "k1",
    unitsSystem: "us",
    defaultPantryMode: "prefer",
    members,
    slotRules
  } satisfies KitchenView;
}

function ingredient(originalText: string, name = originalText): IngredientDraft {
  return { originalText, name, quantity: null, unit: null, section: "other", checkLabel: false };
}

describe("planSkeleton", () => {
  const you = member({ memberId: "you", isSelf: true });
  const sam = member({ memberId: "sam", mealPattern: ["breakfast", "dinner"] });

  it("returns one day per requested day, in date order across a month end", () => {
    const days = planSkeleton(kitchen([you]), { startDate: "2026-10-30", days: 3 });
    expect(days.map((day) => day.date)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
  });

  it("shares a slot among everyone whose pattern holds it", () => {
    const [day] = planSkeleton(kitchen([you, sam]), { startDate: "2026-11-02", days: 1 });
    expect(day?.meals).toEqual([
      { slotName: "breakfast", slotPosition: 0, sharing: "shared", eaterIds: ["you", "sam"] },
      { slotName: "lunch", slotPosition: 1, sharing: "shared", eaterIds: ["you"] },
      { slotName: "dinner", slotPosition: 2, sharing: "shared", eaterIds: ["you", "sam"] }
    ]);
  });

  it("splits a solo slot into one meal per eater only on the rule's weekdays", () => {
    const both = member({ memberId: "sam" });
    const rules = [{ slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: null }];
    // 2026-11-06 is a Friday, 2026-11-07 a Saturday.
    const [friday, saturday] = planSkeleton(kitchen([you, both], rules), {
      startDate: "2026-11-06",
      days: 2
    });
    expect(friday?.meals.filter((meal) => meal.slotName === "lunch")).toEqual([
      { slotName: "lunch", slotPosition: 1, sharing: "solo", eaterIds: ["you"] },
      { slotName: "lunch", slotPosition: 1, sharing: "solo", eaterIds: ["sam"] }
    ]);
    expect(saturday?.meals.filter((meal) => meal.slotName === "lunch")).toEqual([
      { slotName: "lunch", slotPosition: 1, sharing: "shared", eaterIds: ["you", "sam"] }
    ]);
  });

  it("refuses zero days, more than 28 days and a malformed date", () => {
    expect(() => planSkeleton(kitchen([you]), { startDate: "2026-11-02", days: 0 })).toThrow();
    expect(() => planSkeleton(kitchen([you]), { startDate: "2026-11-02", days: 29 })).toThrow();
    expect(() => planSkeleton(kitchen([you]), { startDate: "2026-02-30", days: 1 })).toThrow();
    expect(planSkeleton(kitchen([you]), { startDate: "2026-11-02", days: 28 })).toHaveLength(28);
  });
});

describe("calorie split, portions and fit", () => {
  it("splits a target evenly over the eater's pattern", () => {
    const sam = member({ memberId: "sam", calorieTarget: 1800 });
    expect(mealShareKcal(sam, "lunch")).toBe(600);
    expect(mealShareKcal({ ...sam, mealPattern: ["dinner", "lunch"] }, "lunch")).toBe(900);
  });

  it("has no share without a target or outside the pattern", () => {
    expect(mealShareKcal(member({ memberId: "a" }), "lunch")).toBeNull();
    expect(
      mealShareKcal(
        member({ memberId: "a", calorieTarget: 2000, mealPattern: ["dinner"] }),
        "lunch"
      )
    ).toBeNull();
  });

  it("rounds a portion to halves between 0.5 and 2", () => {
    expect(portionFor(600, 400)).toBe(1.5);
    expect(portionFor(600, 500)).toBe(1);
    expect(portionFor(100, 900)).toBe(0.5);
    expect(portionFor(3000, 500)).toBe(2);
    expect(portionFor(null, 500)).toBe(1);
    expect(portionFor(600, null)).toBe(1);
    expect(portionFor(600, 0)).toBe(1);
  });

  it("calls a meal on target within 15 percent", () => {
    expect(calorieFit(600, 690)).toEqual({
      targetKcal: 600,
      estimatedKcal: 690,
      band: "on",
      differenceKcal: 90
    });
    expect(calorieFit(600, 691).band).toBe("over");
    expect(calorieFit(600, 510).band).toBe("on");
    expect(calorieFit(600, 509)).toMatchObject({ band: "under", differenceKcal: -91 });
  });
});

describe("deterministic Safety", () => {
  it("fails a peanut ingredient for a no-peanut eater", () => {
    const verdict = deterministicSafety(
      [ingredient("2 tbsp smooth peanut butter", "peanut butter")],
      ["no peanuts"]
    );
    expect(verdict.verdict).toBe("fail");
  });

  it("reads the original line, not only the parsed name", () => {
    const verdict = deterministicSafety(
      [ingredient("1 cup satay sauce (contains peanuts)", "satay sauce")],
      ["peanuts"]
    );
    expect(verdict.verdict).toBe("fail");
  });

  it("expands diet words to the foods they rule out", () => {
    const chicken = [ingredient("2 chicken thighs", "chicken thighs")];
    expect(deterministicSafety(chicken, ["vegetarian"]).verdict).toBe("fail");
    expect(deterministicSafety([ingredient("100 g feta")], ["vegan"]).verdict).toBe("fail");
    expect(deterministicSafety([ingredient("200 g spaghetti")], ["gluten-free"]).verdict).toBe(
      "fail"
    );
    expect(deterministicSafety([ingredient("8 prawns")], ["shellfish"]).verdict).toBe("fail");
  });

  it.each([
    ["peanut allergy", "2 tbsp peanut butter"],
    ["nut allergy", "2 tbsp peanut butter"],
    ["peanut allergies", "2 tbsp peanut butter"],
    ["allergic to nuts", "50 g cashews"],
    ["nut-free", "2 tbsp peanut butter"],
    ["peanut-free", "2 tbsp peanut butter"],
    ["shellfish allergy", "8 shrimp"],
    ["seafood intolerance", "8 shrimp"],
    ["lactose intolerant", "50 g cheddar"],
    ["dairy sensitivity", "50 g cheddar"],
    ["Egg-free", "2 eggs"]
  ])("fails a conflicting ingredient for the restriction %j", (restriction, line) => {
    expect(deterministicSafety([ingredient(line)], [restriction]).verdict).toBe("fail");
  });

  it("does not match inside an unrelated word", () => {
    const verdict = deterministicSafety(
      [ingredient("1 tsp nutmeg"), ingredient("200 ml coconut milk")],
      ["nuts"]
    );
    expect(verdict.verdict).toBe("pass");
  });

  it("passes when nothing matches and when there are no restrictions", () => {
    const meal = [ingredient("1 onion"), ingredient("2 carrots")];
    expect(deterministicSafety(meal, ["no peanuts", "vegetarian"]).verdict).toBe("pass");
    expect(deterministicSafety(meal, []).verdict).toBe("pass");
  });

  it("lets the model only add a failure, never clear one", () => {
    const pass = { verdict: "pass" } as const;
    const ruleFail = { verdict: "fail", reason: "Contains peanut" } as const;
    const modelFail = { verdict: "fail", reason: "Fish sauce is not vegetarian" } as const;
    expect(mergeSafety(pass, modelFail)).toEqual(modelFail);
    expect(mergeSafety(ruleFail, pass)).toEqual(ruleFail);
    expect(mergeSafety(ruleFail, modelFail)).toEqual(ruleFail);
    expect(mergeSafety(pass, null)).toEqual(pass);
    expect(mergeSafety(pass, pass)).toEqual(pass);
  });
});

describe("brand rule", () => {
  it("flags a brand mark, a named brand and a packaged product", () => {
    expect(brandRule("1 jar Patak's tikka masala paste")).toBe(true);
    expect(brandRule("2 tbsp Sriracha™")).toBe(true);
    expect(brandRule("1 stock cube")).toBe(true);
    expect(brandRule("1 can chopped tomatoes")).toBe(true);
    expect(brandRule("2 carrots, diced")).toBe(false);
    expect(brandRule("Salt and pepper")).toBe(false);
  });

  it("adds the flag and never clears the model's", () => {
    const flagged = applyBrandRule([
      ingredient("1 stock cube"),
      { ...ingredient("1 onion"), checkLabel: true },
      ingredient("2 carrots")
    ]);
    expect(flagged.map((line) => line.checkLabel)).toEqual([true, true, false]);
  });
});

describe("no-repeat rule", () => {
  it("compares titles by their key", () => {
    expect(titleKey("Chicken Tikka Masala!")).toBe(titleKey("  chicken   tikka masala "));
    expect(titleKey("Crème brûlée")).toBe("creme brulee");
    expect(titleKey("Lentil soup")).not.toBe(titleKey("Lentil stew"));
  });

  it("keeps a key for a title with no letters or digits", () => {
    expect(titleKey("!!!").length).toBeGreaterThan(0);
  });

  it("finds a repeat among recent keys", () => {
    const recent = new Set([titleKey("Lentil soup")]);
    expect(isRepeat(titleKey("LENTIL SOUP"), recent)).toBe(true);
    expect(isRepeat(titleKey("Lentil stew"), recent)).toBe(false);
  });
});
