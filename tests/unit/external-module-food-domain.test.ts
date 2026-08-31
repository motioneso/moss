// tests/unit/external-module-food-domain.test.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 7): pure domain coverage — no db, no kv, no ai.
// Behaviours from the plan, each named after the "fails if" clause it targets:
//   3  Nutrients never zero-filled (computeDailyTotals)
//   4  Totals exclude incomplete meals (computeDailyTotals)
//   5  Local-date pinning (resolveMealLocalDate)
//   6  DST boundary (resolveMealLocalDate)
//   14 Empty day names its date (computeDailyTotals)
// Plus domain/estimate.ts's validateNutrients (guard 3 of the determinism boundary), which
// underpins behaviour 3 at its source: an estimator outcome must never coerce undefined -> 0.
import { describe, expect, it } from "vitest";

import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { validateNutrients } from "../../external-modules/food/src/domain/estimate.js";
import { NO_TARGETS, resolveDailyTargets } from "../../external-modules/food/src/domain/targets.js";
import {
  parseConsumedAtInstant,
  resolveMealLocalDate
} from "../../external-modules/food/src/domain/meal.js";
import type { Meal, MealItem, Nutrients } from "../../external-modules/food/src/domain/meal.js";
import {
  computeDailyTotals,
  isNutrientComplete,
  netCarbsG,
  sumItemNutrients
} from "../../external-modules/food/src/domain/totals.js";
import { occasionForMeal } from "../../external-modules/food/src/domain/occasion.js";
import { parseEstimateResult } from "../../external-modules/food/src/estimator/schema.js";

const NULL_NUTRIENTS: Nutrients = {
  caloriesKcal: null,
  proteinG: null,
  carbohydratesG: null,
  fatG: null,
  fiberG: null,
  sugarG: null,
  sodiumMg: null
};

function meal(overrides: Partial<Meal>): Meal {
  return {
    items: [],
    mealId: "meal-1",
    consumedAt: "2026-07-18T12:00:00.000Z",
    localDate: "2026-07-18",
    timezoneOffset: 0,
    description: "a bowl of oatmeal",
    servingNote: null,
    captureKind: "text",
    estimateState: "pending",
    estimateRevision: 0,
    nutrients: null,
    missingDetails: null,
    ...overrides
  };
}

describe("computeDailyTotals (plan §4 Task 7)", () => {
  it("test 14: an empty day names its date rather than reading it off meals[0]", () => {
    // Zero meals is not the same as an incomplete day — nothing failed to estimate, there is
    // simply nothing logged. A meals[0]-derived date would throw/return undefined here instead
    // of naming 2026-07-20 at all, which is the actual bug this test guards against.
    const totals = computeDailyTotals("2026-07-20", []);
    expect(totals).toEqual({
      localDate: "2026-07-20",
      nutrients: NULL_NUTRIENTS,
      incomplete: false,
      mealsWithoutEstimate: 0
    });
  });

  it("test 3: needs_details/pending/failed meals never contribute a coerced 0", () => {
    // A broken mapper would coerce `undefined -> 0` for the incomplete meal's nutrients;
    // the correct behaviour is that this meal contributes NOTHING, and any nutrient no
    // estimated meal touched stays null, never 0.
    const pending = meal({ mealId: "m-pending", estimateState: "pending", nutrients: null });
    const totals = computeDailyTotals("2026-07-18", [pending]);
    expect(totals.nutrients).toEqual(NULL_NUTRIENTS);
    expect(totals.incomplete).toBe(true);
    expect(totals.mealsWithoutEstimate).toBe(1);
  });

  it("test 4: totals sum only the estimated meal and flag incomplete for the pending one", () => {
    const estimated = meal({
      mealId: "m-est",
      estimateState: "estimated",
      nutrients: {
        caloriesKcal: 350,
        proteinG: 10,
        carbohydratesG: 65,
        fatG: 6,
        fiberG: 8,
        sugarG: 20,
        sodiumMg: 150
      }
    });
    const pending = meal({ mealId: "m-pending", estimateState: "pending", nutrients: null });
    const totals = computeDailyTotals("2026-07-18", [estimated, pending]);
    // A COALESCE(...,0)-style bug would still produce these same sums here (0 contributes
    // nothing to a sum) — the real assertion is incomplete=true and mealsWithoutEstimate=1,
    // proving the pending meal was excluded from the sum rather than summed as zero.
    expect(totals.nutrients).toEqual({
      caloriesKcal: 350,
      proteinG: 10,
      carbohydratesG: 65,
      fatG: 6,
      fiberG: 8,
      sugarG: 20,
      sodiumMg: 150
    });
    expect(totals.incomplete).toBe(true);
    expect(totals.mealsWithoutEstimate).toBe(1);
  });

  it("a nutrient no estimated meal reported stays null even when other nutrients summed", () => {
    // Guards the per-nutrient `contributed` bookkeeping specifically: an estimated meal
    // with a null sodiumMg must not make the day's sodiumMg read as 0.
    const estimated = meal({
      estimateState: "estimated",
      nutrients: { ...NULL_NUTRIENTS, caloriesKcal: 200, sodiumMg: null }
    });
    const totals = computeDailyTotals("2026-07-18", [estimated]);
    expect(totals.nutrients.caloriesKcal).toBe(200);
    expect(totals.nutrients.sodiumMg).toBeNull();
    expect(totals.incomplete).toBe(false);
    expect(totals.mealsWithoutEstimate).toBe(0);
  });

  it("sums multiple estimated meals' matching nutrient fields", () => {
    const a = meal({
      mealId: "a",
      estimateState: "estimated",
      nutrients: { ...NULL_NUTRIENTS, caloriesKcal: 100, proteinG: 5 }
    });
    const b = meal({
      mealId: "b",
      estimateState: "estimated",
      nutrients: { ...NULL_NUTRIENTS, caloriesKcal: 250, proteinG: 15 }
    });
    const totals = computeDailyTotals("2026-07-18", [a, b]);
    expect(totals.nutrients.caloriesKcal).toBe(350);
    expect(totals.nutrients.proteinG).toBe(20);
    expect(totals.incomplete).toBe(false);
  });
});

describe("resolveMealLocalDate (plan §4 Task 7)", () => {
  it("test 5: local-date pinning — resolved once, not re-derived from a later timezone", () => {
    // 23:30 in America/Los_Angeles on 2026-07-18 is still 2026-07-18 there, even though the
    // UTC instant has already rolled to 2026-07-19. A `.slice(0,10)` on the UTC ISO string
    // (the bug this guards against) would read the WRONG day.
    const consumedAt = new Date("2026-07-19T06:30:00.000Z"); // 23:30 PDT on 2026-07-18
    const resolved = resolveMealLocalDate(consumedAt, "America/Los_Angeles");
    expect(resolved.localDate).toBe("2026-07-18");
    // PDT is UTC-7 in July -> -420 minutes east of UTC.
    expect(resolved.timezoneOffset).toBe(-420);

    // The plan's failure mode: history reshuffles when the user's configured timezone
    // later changes. Prove that by resolving the SAME instant against a different zone and
    // confirming it lands on a different day/offset — this is exactly why local_date and
    // timezone_offset are persisted at create time rather than recomputed at read time.
    const resolvedLater = resolveMealLocalDate(consumedAt, "Australia/Sydney");
    expect(resolvedLater.localDate).not.toBe(resolved.localDate);
  });

  it("test 6: DST spring-forward boundary lands on the correct local date", () => {
    // 2026-03-08 02:30 America/Los_Angeles does not exist (clocks jump 02:00 -> 03:00), but
    // an instant shortly before/after the transition must still resolve to the correct
    // calendar day rather than assuming a fixed UTC offset across the boundary.
    const beforeTransition = new Date("2026-03-08T09:59:00.000Z"); // 01:59 PST (UTC-8)
    const afterTransition = new Date("2026-03-08T10:01:00.000Z"); // 03:01 PDT (UTC-7)

    const before = resolveMealLocalDate(beforeTransition, "America/Los_Angeles");
    const after = resolveMealLocalDate(afterTransition, "America/Los_Angeles");

    expect(before.localDate).toBe("2026-03-08");
    expect(before.timezoneOffset).toBe(-480); // PST
    expect(after.localDate).toBe("2026-03-08");
    expect(after.timezoneOffset).toBe(-420); // PDT — offset itself must shift across the boundary

    // A fixed-offset implementation (using PST's -480 for both instants) would compute the
    // after-transition local time as 02:01, not 03:01, but the calendar DAY still happens to
    // agree here — the offset assertion above is the one that actually catches that bug.
  });

  it("falls back to UTC for an invalid IANA zone name rather than throwing", () => {
    const resolved = resolveMealLocalDate(new Date("2026-07-18T23:30:00.000Z"), "Not/AZone");
    expect(resolved.localDate).toBe("2026-07-18");
    expect(resolved.timezoneOffset).toBe(0);
  });
});

describe("parseConsumedAtInstant (#1869 slice 3B)", () => {
  it("interprets an offset-less local wall clock in the effective IANA zone", () => {
    expect(parseConsumedAtInstant("2026-08-22T20:14:00", "America/Los_Angeles")).toEqual(
      new Date("2026-08-23T03:14:00.000Z")
    );
  });

  it("keeps offset-bearing timestamps as their exact instant", () => {
    const local = parseConsumedAtInstant("2026-08-22T20:14:00", "America/Los_Angeles");
    const offset = parseConsumedAtInstant("2026-08-22T20:14:00-07:00", "UTC");
    const utc = parseConsumedAtInstant("2026-08-23T03:14:00Z", "UTC");
    expect(offset).toEqual(local);
    expect(utc).toEqual(local);
  });

  it.each([
    ["not-a-date", "America/Los_Angeles"],
    ["2026-08-22T20:14:00", "Not/AZone"],
    ["2026-03-08T02:30:00", "America/Los_Angeles"],
    ["2026-11-01T01:30:00", "America/Los_Angeles"]
  ])("rejects invalid consumedAt input %s in %s", (raw, zone) => {
    expect(() => parseConsumedAtInstant(raw, zone)).toThrow();
  });
});

describe("validateNutrients (plan §3 guard 3 / plan §4 Task 7 test 3's source)", () => {
  it("never coerces a missing/undefined field to 0 — it stays null", () => {
    const result = validateNutrients({ caloriesKcal: 400 });
    expect(result.caloriesKcal).toBe(400);
    expect(result.proteinG).toBeNull();
    expect(result.sodiumMg).toBeNull();
  });

  it("rejects non-numeric, NaN/Infinity, negative, and out-of-ceiling values as null", () => {
    const result = validateNutrients({
      caloriesKcal: "400" as unknown as number,
      proteinG: Number.NaN,
      carbohydratesG: Number.POSITIVE_INFINITY,
      fatG: -5,
      fiberG: 9999, // over the 200g single-meal ceiling
      sugarG: 100,
      sodiumMg: 150
    });
    expect(result).toEqual({
      caloriesKcal: null,
      proteinG: null,
      carbohydratesG: null,
      fatG: null,
      fiberG: null,
      sugarG: 100,
      sodiumMg: 150
    });
  });

  it("handles a null or non-object raw payload without throwing", () => {
    expect(validateNutrients(null)).toEqual(NULL_NUTRIENTS);
    expect(validateNutrients(undefined)).toEqual(NULL_NUTRIENTS);
    expect(validateNutrients("not an object")).toEqual(NULL_NUTRIENTS);
  });
});

// ── #1737: a meal is the sum of its items ────────────────────────────────

function item(label: string, nutrients: Partial<Nutrients>): MealItem {
  return { label, portionNote: null, nutrients: { ...NULL_NUTRIENTS, ...nutrients } };
}

describe("sumItemNutrients (#1737)", () => {
  it("adds each nutrient across items", () => {
    const total = sumItemNutrients([
      item("oatmeal", { caloriesKcal: 310, proteinG: 8 }),
      item("banana", { caloriesKcal: 105, proteinG: 1 })
    ]);
    expect(total.caloriesKcal).toBe(415);
    expect(total.proteinG).toBe(9);
  });

  it("leaves a nutrient null only when NO item carried it, never zero", () => {
    // Fails against an implementation that seeds the sum at 0 and returns it: the
    // meal would read as "0 g fiber" — a claim nothing measured — instead of unknown.
    const total = sumItemNutrients([
      item("wings", { caloriesKcal: 700, fiberG: 2 }),
      item("Coke Zero", { caloriesKcal: 0 })
    ]);
    expect(total.caloriesKcal).toBe(700);
    expect(total.fiberG).toBe(2); // one item knew it; the other contributes nothing, not 0
    expect(total.sugarG).toBeNull(); // neither item knew it
  });

  it("returns all-null for an empty breakdown", () => {
    expect(sumItemNutrients([])).toEqual(NULL_NUTRIENTS);
  });
});

describe("isNutrientComplete (#1737)", () => {
  const items = [item("wings", { caloriesKcal: 700 }), item("Coke Zero", {})];

  it("is false when any item is missing that nutrient", () => {
    expect(isNutrientComplete(items, "caloriesKcal")).toBe(false);
  });

  it("is true only when every item carries it", () => {
    expect(isNutrientComplete([item("wings", { caloriesKcal: 700 })], "caloriesKcal")).toBe(true);
  });

  it("is false for an empty breakdown", () => {
    expect(isNutrientComplete([], "caloriesKcal")).toBe(false);
  });
});

describe("parseEstimateResult items (#1737)", () => {
  const oneItem = {
    label: "oatmeal",
    portionNote: "1 bowl",
    caloriesKcal: 310,
    proteinG: 8,
    carbohydratesG: 55,
    fatG: 5,
    fiberG: 8,
    sugarG: 2,
    sodiumMg: 140
  };

  it("reads the breakdown, keeping nutrient values untouched for guard 3", () => {
    const parsed = parseEstimateResult({
      outcome: "estimated",
      items: [oneItem],
      missingDetails: null,
      clarificationQuestion: null
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.label).toBe("oatmeal");
    expect(parsed.items[0]!.nutrientFields["caloriesKcal"]).toBe(310);
  });

  it("rejects an estimate with no items", () => {
    // Fails against an implementation that accepts a bare meal-level figure: without
    // this, "estimated" with an empty breakdown would persist a total nothing explains.
    expect(() =>
      parseEstimateResult({
        outcome: "estimated",
        items: [],
        missingDetails: null,
        clarificationQuestion: null
      })
    ).toThrow(/at least one item/);
  });

  it("rejects an invented field on an item, not only at the top level", () => {
    expect(() =>
      parseEstimateResult({
        outcome: "estimated",
        items: [{ ...oneItem, brandGuess: "Quaker" }],
        missingDetails: null,
        clarificationQuestion: null
      })
    ).toThrow(/items\[0\].brandGuess/);
  });
});

describe("netCarbsG (#1737, spec test 7)", () => {
  it("subtracts fiber from total carbohydrates", () => {
    expect(netCarbsG({ ...NULL_NUTRIENTS, carbohydratesG: 60, fiberG: 8 })).toBe(52);
  });

  it("is unknown when either input is unknown, rather than treating fiber as zero", () => {
    // Fails against `carbs - (fiber ?? 0)`, which would answer 60 here — the largest
    // possible net figure, presented as if it had been measured.
    expect(netCarbsG({ ...NULL_NUTRIENTS, carbohydratesG: 60 })).toBeNull();
    expect(netCarbsG({ ...NULL_NUTRIENTS, fiberG: 8 })).toBeNull();
    expect(netCarbsG(null)).toBeNull();
  });

  it("does not floor a fiber figure larger than the carbohydrate figure", () => {
    // Estimates disagree with each other sometimes. Clamping to 0 would hide that; a
    // negative number is visibly wrong, which is the honest outcome.
    expect(netCarbsG({ ...NULL_NUTRIENTS, carbohydratesG: 5, fiberG: 8 })).toBe(-3);
  });
});

describe("occasionForMeal (#1737)", () => {
  /** Builds an instant that reads as `hour` in a zone `offsetMinutes` from UTC. */
  function atLocalHour(hour: number, offsetMinutes: number): string {
    return new Date(Date.UTC(2026, 7, 19, hour, 0) - offsetMinutes * 60_000).toISOString();
  }

  it("buckets by the hour of the meal's own timezone, not the viewer's", () => {
    // 08:00 in a UTC-7 zone. A viewer in UTC reading the raw instant would see 15:00 and
    // file breakfast under lunch — the bug this test exists for.
    expect(occasionForMeal(atLocalHour(8, -420), -420)).toBe("breakfast");
    expect(occasionForMeal(atLocalHour(13, -420), -420)).toBe("lunch");
    expect(occasionForMeal(atLocalHour(19, 330), 330)).toBe("dinner");
  });

  it("puts late-night eating in the snack bucket rather than the next morning's breakfast", () => {
    expect(occasionForMeal(atLocalHour(23, 0), 0)).toBe("snack");
    expect(occasionForMeal(atLocalHour(2, 0), 0)).toBe("snack");
    expect(occasionForMeal(atLocalHour(4, 0), 0)).toBe("breakfast");
  });

  it("falls back to snack for an unparseable timestamp instead of throwing", () => {
    // One bad row must not blank out the whole day view.
    expect(occasionForMeal("not a date", 0)).toBe("snack");
  });
});

// #1757 / #1737 item 4: the four daily targets, read off the preference set the host resolves
// before every invocation. Food never reads the host's preference store itself.
describe("resolveDailyTargets (#1737 item 4)", () => {
  const withPreferences = (preferences: Record<string, unknown>) =>
    resolveDailyTargets({ preferences } as unknown as ModuleWorkerContext);

  it("reads the four targets under their manifest keys", () => {
    expect(
      withPreferences({
        calorieTarget: 2200,
        proteinTarget: 150,
        carbTarget: 100,
        fatTarget: 70,
        aiEstimates: true
      })
    ).toEqual({ caloriesKcal: 2200, proteinG: 150, netCarbsG: 100, fatG: 70 });
  });

  it("treats an unset target as no target", () => {
    expect(withPreferences({ calorieTarget: null })).toEqual(NO_TARGETS);
    expect(withPreferences({})).toEqual(NO_TARGETS);
  });

  it("reads zero and anything non-numeric as no target", () => {
    // A target of zero calories is not a goal anyone holds, and honouring one would put the day
    // permanently over target. Same for a value the resolver should never produce at all.
    for (const value of [0, -100, "2000", true, Number.NaN]) {
      expect(withPreferences({ calorieTarget: value }).caloriesKcal, String(value)).toBeNull();
    }
  });
});
