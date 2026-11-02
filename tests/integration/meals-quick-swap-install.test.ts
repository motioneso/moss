// tests/integration/meals-quick-swap-install.test.ts
//
// Meals S9 (#3893): the quick swap column and job-generation guard on the real installed schema.
// A stale quick job writes nothing, the newest ask owns the meal, and a second owner cannot reach
// it at all. The install fixture is shared in meals-install-harness.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ids } from "./test-database.js";
import { asPlanActor, seedPlan, startMeals, stopMeals, uuid } from "./meals-install-harness.js";

beforeAll(async () => {
  await startMeals();
});

afterAll(async () => {
  await stopMeals();
});

describe("quick swap (S9 #3893)", () => {
  it("stores the cap, saves only under the current job generation, and keeps a second owner out", async () => {
    const seeded = await seedPlan(ids.userA, 8000, "s9-quick");
    const dayId = seeded.days[0]!.dayId;
    const mealId = uuid(8010);
    const recipe = (n: number, title: string) => ({
      recipeId: uuid(n),
      title,
      titleKey: title.toLowerCase(),
      steps: ["Cook."],
      cookMinutes: 10,
      baseServings: 2,
      kcalPerServing: 500,
      ingredients: [
        {
          originalText: "1 cup rice",
          name: "Rice",
          quantity: 1,
          unit: "cup",
          section: "pantry" as const,
          checkLabel: false
        }
      ]
    });
    const eaters = [
      {
        memberId: seeded.self,
        portion: 1,
        estimatedKcal: 500,
        safety: "pass" as const,
        safetyReason: null
      }
    ];
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.bumpDay(dayId))!;
      await plans.claimDay(dayId, generation);
      await plans.claimMeal(mealId, dayId, generation);
      await plans.saveMealReady({
        mealId,
        generation,
        attempts: 1,
        kitchenId: seeded.kitchenId,
        recipe: recipe(8100, "Original 8000"),
        eaters
      });

      const first = (await plans.startQuickSwap(mealId, 15))!;
      const second = (await plans.startQuickSwap(mealId, 20))!;
      expect((await plans.getMeal(mealId))!.quickMaxMinutes).toBe(20);
      expect(await plans.claimQuickSwap(mealId, first)).toBe(false);
      expect(await plans.claimQuickSwap(mealId, second)).toBe(true);
      expect(
        await plans.saveQuickSwap({
          mealId,
          generation: first,
          kitchenId: seeded.kitchenId,
          recipe: recipe(8200, "Stale dish"),
          eaters,
          attempts: 1
        })
      ).toBe(false);
      expect(
        await plans.saveQuickSwap({
          mealId,
          generation: second,
          kitchenId: seeded.kitchenId,
          recipe: recipe(8300, "Quick dish"),
          eaters,
          attempts: 1
        })
      ).toBe(true);
      const meal = (await plans.getMeal(mealId))!;
      expect(meal.status).toBe("ready");
      expect(meal.quickMaxMinutes).toBe(20);
      expect(meal.recipeId).toBe(uuid(8300));
    });
    await asPlanActor(ids.userB, async (plans) => {
      expect(await plans.startQuickSwap(mealId, 15)).toBeNull();
      expect(await plans.claimQuickSwap(mealId, 3)).toBe(false);
    });
  });
});
