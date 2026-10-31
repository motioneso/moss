// tests/unit/external-module-meals-plan-read.test.ts
//
// Meals phase 2 slice 3 (#3887): the plan the Plan tab reads, and the meals a plan covers.

import { describe, expect, it } from "vitest";

import { planCreate, planCurrent } from "../../external-modules/meals/src/plans/tools.js";
import {
  ESTIMATE_800,
  fakeDeps,
  kitchenOf,
  member,
  recipeAnswer,
  safetyPass,
  ScriptedAi
} from "./helpers/meals-plan-fake.js";

const you = member({
  memberId: "m-you",
  name: "You",
  isSelf: true,
  mealPattern: ["breakfast", "lunch", "dinner"]
});

function ai() {
  return new ScriptedAi()
    .always("recipe", recipeAnswer({ title: "Lentil soup" }))
    .always("safety", safetyPass(1))
    .always("estimate", ESTIMATE_800);
}

function input(overrides: Record<string, unknown> = {}) {
  return { startDate: "2026-11-02", days: 1, idempotencyKey: "plan-1", ...overrides };
}

describe("meal types", () => {
  it("plans only the meals named, matching case", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    const plan = await planCreate(setup.deps, input({ days: 2, mealTypes: ["Dinner"] }));
    expect(plan.days.flatMap((day) => day.meals.map((meal) => meal.slotName))).toEqual([
      "dinner",
      "dinner"
    ]);
  });

  it("rejects meals nobody eats and empty lists", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    await expect(
      planCreate(setup.deps, input({ idempotencyKey: "a", mealTypes: ["elevenses"] }))
    ).rejects.toThrow("No one in the household eats");
    await expect(
      planCreate(setup.deps, input({ idempotencyKey: "b", mealTypes: [] }))
    ).rejects.toThrow("mealTypes");
  });

  it("plans every meal the household eats when none are named", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    const plan = await planCreate(setup.deps, input());
    expect(plan.days[0]!.meals.map((meal) => meal.slotName)).toEqual([
      "breakfast",
      "lunch",
      "dinner"
    ]);
  });
});

describe("current plan", () => {
  it("returns null when nothing is planned", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    expect(await planCurrent(setup.deps, { date: "2026-11-02" })).toEqual({ plan: null });
  });

  it("prefers the plan covering the date, then the next to start, then the newest", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    const first = await planCreate(setup.deps, input({ days: 3, idempotencyKey: "a" }));
    const later = await planCreate(
      setup.deps,
      input({ startDate: "2026-11-16", days: 3, idempotencyKey: "b" })
    );
    const planOn = async (date: string) => (await planCurrent(setup.deps, { date })).plan?.planId;
    expect(await planOn("2026-11-03")).toBe(first.planId);
    expect(await planOn("2026-11-10")).toBe(later.planId);
    expect(await planOn("2026-12-30")).toBe(later.planId);
  });

  it("rejects a date that is not a date", async () => {
    const setup = fakeDeps(kitchenOf([you]), ai());
    await expect(planCurrent(setup.deps, { date: "tomorrow" })).rejects.toThrow("date");
  });
});
