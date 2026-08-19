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

import { validateNutrients } from "../../external-modules/food/src/domain/estimate.js";
import { resolveMealLocalDate } from "../../external-modules/food/src/domain/meal.js";
import type { Meal, Nutrients } from "../../external-modules/food/src/domain/meal.js";
import { computeDailyTotals } from "../../external-modules/food/src/domain/totals.js";

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
