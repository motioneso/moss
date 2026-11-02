// tests/unit/external-module-meals-replan.test.ts
//
// Meals phase 2 slice 9 (#3893): mid-week re-plan and quick swap, against an in-memory store, a
// scripted model and a recording enqueue.

import { describe, expect, it } from "vitest";

import type { KitchenView } from "../../external-modules/meals/src/contracts.js";
import { missingFor, replanScope } from "../../external-modules/meals/src/domain/replan.js";
import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { MEAL_JOB_QUEUE, type PlanDeps } from "../../external-modules/meals/src/plans/deps.js";
import { runMealJob } from "../../external-modules/meals/src/plans/meal-job.js";
import { mealSwap } from "../../external-modules/meals/src/plans/meal-tools.js";
import {
  mealGet,
  planControl,
  planCreate,
  planGet
} from "../../external-modules/meals/src/plans/tools.js";
import { titleKey } from "../../external-modules/meals/src/domain/repeats.js";
import {
  ESTIMATE_800,
  fakeDeps,
  kitchenOf,
  member,
  recipeAnswer,
  safetyPass,
  ScriptedAi
} from "./helpers/meals-plan-fake.js";
import { FakePantryStore } from "./helpers/meals-pantry-fake.js";

const you = member({ memberId: "aaaaaaaa-0000-4000-8000-000000000001", name: "You", isSelf: true });
const sam = member({ memberId: "aaaaaaaa-0000-4000-8000-000000000002", name: "Sam" });

function kitchen(
  rules: KitchenView["slotRules"] = [{ slotName: "dinner", soloWeekdays: [], usualTime: "18:00" }]
): KitchenView {
  return { ...kitchenOf([you, sam]), slotRules: rules };
}

function happyAi(eaters = 2): ScriptedAi {
  return new ScriptedAi()
    .always("recipe", recipeAnswer())
    .always("safety", safetyPass(eaters))
    .always("estimate", ESTIMATE_800);
}

type Setup = ReturnType<typeof fakeDeps>;

async function drain(setup: Setup, deps: PlanDeps = setup.deps, limit = 80): Promise<void> {
  for (let run = 0; run < limit; run += 1) {
    const call = setup.jobs.calls.shift();
    if (call === undefined) return;
    if (call.queue === MEAL_JOB_QUEUE) await runMealJob(deps, call.params);
    else await runPlanDay(deps, call.params);
  }
  throw new Error("jobs did not settle");
}

async function planned(input: {
  days?: number;
  pantryMode?: string;
  ai?: ScriptedAi;
  at?: string;
  zone?: string;
  pantry?: FakePantryStore;
}) {
  const ai = input.ai ?? happyAi();
  const setup = fakeDeps(kitchen(), ai);
  const deps: PlanDeps = {
    ...setup.deps,
    now: () => new Date(input.at ?? "2026-11-03T12:00:00Z"),
    localTimezone: input.zone ?? "UTC",
    ...(input.pantry ? { pantry: input.pantry } : {})
  };
  const plan = await planCreate(deps, {
    startDate: "2026-11-02",
    days: input.days ?? 4,
    idempotencyKey: "plan-1",
    ...(input.pantryMode ? { pantryMode: input.pantryMode } : {})
  });
  await drain(setup, deps);
  const meals = [...setup.store.meals.values()].sort((a, b) =>
    (setup.store.days.get(a.dayId)?.date ?? "").localeCompare(
      setup.store.days.get(b.dayId)?.date ?? ""
    )
  );
  return { setup, deps, planId: plan.planId, meals };
}

describe("Re-plan scope", () => {
  it("keeps past days and replaces today before its usual time and later days", async () => {
    const { deps, planId } = await planned({});
    const view = await planGet(deps, { planId });
    const ids = replanScope(view, new Date("2026-11-03T12:00:00Z"), "UTC", kitchen().slotRules);
    const byDate = new Map(
      view.days.map((day) => [day.date, day.meals.map((meal) => meal.mealId)])
    );
    expect(ids).toEqual([
      ...(byDate.get("2026-11-03") ?? []),
      ...(byDate.get("2026-11-04") ?? []),
      ...(byDate.get("2026-11-05") ?? [])
    ]);
  });

  it("keeps today's meal once its usual time has passed", async () => {
    const { deps, planId } = await planned({});
    const view = await planGet(deps, { planId });
    const ids = replanScope(view, new Date("2026-11-03T19:00:00Z"), "UTC", kitchen().slotRules);
    const todayIds = view.days.find((day) => day.date === "2026-11-03")!.meals.map((m) => m.mealId);
    for (const id of todayIds) expect(ids).not.toContain(id);
    expect(ids.length).toBe(2);
  });

  it("judges today in the household zone, not UTC", async () => {
    const { deps, planId } = await planned({});
    const view = await planGet(deps, { planId });
    // 23:30 UTC is 18:30 in New York, before a 19:00 dinner.
    const rules = [{ slotName: "dinner", soloWeekdays: [], usualTime: "19:00" }];
    const ids = replanScope(view, new Date("2026-11-03T23:30:00Z"), "America/New_York", rules);
    const todayIds = view.days.find((day) => day.date === "2026-11-03")!.meals.map((m) => m.mealId);
    for (const id of todayIds) expect(ids).toContain(id);
  });

  it("replaces only in-scope meals and keeps locked and cooked meals", async () => {
    const { setup, deps, planId, meals } = await planned({});
    const before = new Map(meals.map((meal) => [meal.mealId, meal.recipeId]));
    meals[2]!.locked = true;
    meals[3]!.cookedAt = "2026-11-05T18:00:00Z";

    await planControl(deps, { planId, action: "replan" });
    await drain(setup, deps);

    expect(meals[0]!.recipeId).toBe(before.get(meals[0]!.mealId)); // past day
    expect(meals[1]!.recipeId).not.toBe(before.get(meals[1]!.mealId)); // today, before 18:00
    expect(meals[2]!.recipeId).toBe(before.get(meals[2]!.mealId)); // locked
    expect(meals[3]!.recipeId).toBe(before.get(meals[3]!.mealId)); // cooked
  });

  it("uses the household zone from the deps when chat sends none", async () => {
    const { setup, deps, planId, meals } = await planned({
      at: "2026-11-03T23:30:00Z",
      zone: "America/New_York"
    });
    setup.store.plans.get(planId);
    const before = meals[1]!.recipeId;
    await planControl(deps, { planId, action: "replan" });
    await drain(setup, deps);
    // Dinner's usual time is 18:00. New York is at 18:30, so today's meal stays.
    expect(meals[1]!.recipeId).toBe(before);
    expect(meals[2]!.recipeId).not.toBeNull();
  });

  it("forces prefer on hand when the plan ignored the Pantry", async () => {
    const { deps, planId } = await planned({ pantryMode: "ignore" });

    await planControl(deps, { planId, action: "replan" });

    expect((await planGet(deps, { planId })).pantryMode).toBe("prefer");
  });

  it("refuses when there is nothing left to re-plan", async () => {
    const { deps, planId } = await planned({ at: "2026-11-06T12:00:00Z" });
    await expect(planControl(deps, { planId, action: "replan" })).rejects.toThrow(
      "nothing to re-plan"
    );
  });
});

describe("Quick swap", () => {
  async function quickSetup(pantry?: FakePantryStore) {
    const base = await planned({ days: 1, pantry });
    const meal = base.meals[0]!;
    return { ...base, meal };
  }

  it("saves a meal inside the cap on the interactive tier and lists what is still to buy", async () => {
    const pantry = new FakePantryStore();
    pantry.seed("rice");
    const { setup, deps, meal } = await quickSetup(pantry);
    setup.ai.script(
      "recipe",
      recipeAnswer({ title: "Fast rice bowl", cookMinutes: 15, lines: ["1 cup rice", "2 carrots"] })
    );

    const asked = await mealSwap(deps, { mealId: meal.mealId, action: "quick", maxMinutes: 15 });
    expect(asked.meal.quickMaxMinutes).toBe(15);
    await drain(setup, deps);

    const view = await mealGet(deps, { mealId: meal.mealId });
    expect(view.meal.title).toBe("Fast rice bowl");
    expect(view.meal.cookMinutes).toBe(15);
    const missing = new Map(view.ingredients.map((line) => [line.name, line.missing]));
    expect(missing.get("rice")).toBe(false);
    expect(missing.get("carrots")).toBe(true);
    const recipeCalls = setup.ai.calls.filter((call) => call.kind === "recipe");
    expect(recipeCalls.at(-1)?.tierHint).toBe("interactive");
  });

  it("never saves a dish over the cap", async () => {
    const { setup, deps, meal } = await quickSetup();
    const before = meal.recipeId;
    setup.ai.script("recipe", recipeAnswer({ title: "Slow stew", cookMinutes: 45 }));
    await mealSwap(deps, { mealId: meal.mealId, action: "quick", maxMinutes: 15 });
    await drain(setup, deps);
    expect(meal.recipeId).toBe(before);
    expect(meal.status).toBe("failed");
  });

  it("rejects a bad cap", async () => {
    const { deps, meal } = await quickSetup();
    await expect(
      mealSwap(deps, { mealId: meal.mealId, action: "quick", maxMinutes: 2 })
    ).rejects.toThrow("maxMinutes");
    await expect(mealSwap(deps, { mealId: meal.mealId, action: "quick" })).rejects.toThrow(
      "maxMinutes"
    );
  });

  it("never offers a dish someone eating the meal rated one star", async () => {
    const { setup, deps, meal, planId } = await quickSetup();
    setup.store.plans.get(planId)!.allowRepeats = true;
    const vetoDeps: PlanDeps = {
      ...deps,
      vetoes: async () => [{ memberId: you.memberId, title: "Satay", titleKey: titleKey("Satay") }]
    };
    setup.ai.script(
      "recipe",
      recipeAnswer({ title: "Satay", cookMinutes: 10 }),
      recipeAnswer({ title: "Quick noodles", cookMinutes: 10 })
    );
    await mealSwap(vetoDeps, { mealId: meal.mealId, action: "quick", maxMinutes: 15 });
    await drain(setup, vetoDeps);
    expect((await mealGet(vetoDeps, { mealId: meal.mealId })).meal.title).toBe("Quick noodles");
  });

  it("a stale quick job writes nothing", async () => {
    const { setup, deps, meal } = await quickSetup();
    setup.ai.script(
      "recipe",
      recipeAnswer({ title: "Second dish", cookMinutes: 10 }),
      recipeAnswer({ title: "First dish", cookMinutes: 10 })
    );
    await mealSwap(deps, { mealId: meal.mealId, action: "quick", maxMinutes: 15 });
    await mealSwap(deps, { mealId: meal.mealId, action: "quick", maxMinutes: 20 });
    const [first, second] = setup.jobs.calls.splice(0);
    expect(await runMealJob(deps, second!.params)).toMatchObject({ status: "done" });
    expect(await runMealJob(deps, first!.params)).toEqual({ status: "stale" });
    expect((await mealGet(deps, { mealId: meal.mealId })).meal.title).toBe("Second dish");
  });
});

describe("missingFor", () => {
  it("names what the Pantry does not cover and leaves staples out", () => {
    const pantry = {
      items: [
        {
          itemId: "i1",
          name: "rice",
          quantity: null,
          unit: null,
          source: "manual" as const,
          updatedAt: "2026-11-02T00:00:00Z"
        }
      ],
      staples: [{ stapleId: "s1", name: "salt" }]
    };
    const line = (name: string) => ({ name, quantity: null, unit: null });
    expect(missingFor([line("rice"), line("salt"), line("carrots")], pantry)).toEqual(["carrots"]);
  });
});
