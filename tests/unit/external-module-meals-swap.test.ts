// tests/unit/external-module-meals-swap.test.ts
//
// Meals phase 2 slice 7 (#3891): lock, regenerate, swap and the Safety re-run, against an
// in-memory store, a scripted model and a recording enqueue.

import { describe, expect, it } from "vitest";

import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { MEAL_JOB_QUEUE, type PlanDeps } from "../../external-modules/meals/src/plans/deps.js";
import { runMealJob } from "../../external-modules/meals/src/plans/meal-job.js";
import { mealEdit, mealSwap } from "../../external-modules/meals/src/plans/meal-tools.js";
import { titleKey } from "../../external-modules/meals/src/domain/repeats.js";
import {
  mealGet,
  planControl,
  planCreate,
  planGet
} from "../../external-modules/meals/src/plans/tools.js";
import { HANDLERS } from "../../external-modules/meals/src/worker/registry.js";
import {
  ESTIMATE_800,
  fakeDeps,
  kitchenOf,
  member,
  recipeAnswer,
  safetyPass,
  ScriptedAi
} from "./helpers/meals-plan-fake.js";

const you = member({ memberId: "aaaaaaaa-0000-4000-8000-000000000001", name: "You", isSelf: true });
const sam = member({ memberId: "aaaaaaaa-0000-4000-8000-000000000002", name: "Sam" });

function happyAi(eaters = 2): ScriptedAi {
  return new ScriptedAi()
    .always("recipe", recipeAnswer())
    .always("safety", safetyPass(eaters))
    .always("estimate", ESTIMATE_800);
}

type Setup = ReturnType<typeof fakeDeps>;

/** Runs queued jobs one at a time, as the queue would, until none are left. */
async function drain(setup: Setup, deps: PlanDeps = setup.deps, limit = 60): Promise<void> {
  for (let run = 0; run < limit; run += 1) {
    const call = setup.jobs.calls.shift();
    if (call === undefined) return;
    if (call.queue === MEAL_JOB_QUEUE) await runMealJob(deps, call.params);
    else await runPlanDay(deps, call.params);
  }
  throw new Error("jobs did not settle");
}

async function planned(days = 3, ai = happyAi()) {
  const setup = fakeDeps(kitchenOf([you, sam]), ai);
  const plan = await planCreate(setup.deps, {
    startDate: "2026-11-02",
    days,
    idempotencyKey: "plan-1"
  });
  await drain(setup);
  const meals = [...setup.store.meals.values()].sort((a, b) =>
    (setup.store.days.get(a.dayId)?.date ?? "").localeCompare(
      setup.store.days.get(b.dayId)?.date ?? ""
    )
  );
  return { setup, planId: plan.planId, meals };
}

describe("Lock", () => {
  it("locks and unlocks a written meal", async () => {
    const { setup, meals } = await planned(1);
    const id = meals[0]!.mealId;
    expect((await mealEdit(setup.deps, { mealId: id, action: "lock" })).meal.locked).toBe(true);
    expect((await mealEdit(setup.deps, { mealId: id, action: "unlock" })).meal.locked).toBe(false);
  });

  it("refuses to lock a meal that is not written, cooked or plain text", async () => {
    const { setup, meals } = await planned(3);
    const [a, b, c] = meals;
    a!.status = "pending";
    b!.cookedAt = "2026-11-03T18:00:00Z";
    c!.kind = "text";
    for (const meal of [a!, b!, c!]) {
      await expect(mealEdit(setup.deps, { mealId: meal.mealId, action: "lock" })).rejects.toThrow();
      expect(meal.locked).toBe(false);
    }
  });
});

describe("Regenerate", () => {
  it("never rewrites locked, cooked or text meals, and reports how many it replaces", async () => {
    const { setup, planId, meals } = await planned(4);
    const [lockedMeal, cooked, text, open] = meals;
    await mealEdit(setup.deps, { mealId: lockedMeal!.mealId, action: "lock" });
    cooked!.cookedAt = "2026-11-03T18:00:00Z";
    text!.kind = "text";
    const before = new Map(meals.map((meal) => [meal.mealId, meal.recipeId]));

    expect((await planGet(setup.deps, { planId })).replaceable).toBe(1);
    await planControl(setup.deps, { planId, action: "regenerate" });
    await drain(setup);

    for (const kept of [lockedMeal!, cooked!, text!]) {
      expect(kept.recipeId).toBe(before.get(kept.mealId));
    }
    expect(open!.recipeId).not.toBe(before.get(open!.mealId));
    expect(open!.status).toBe("ready");
  });

  it("reports the replaceable count on every plan read", async () => {
    const { setup, planId, meals } = await planned(3);
    await mealEdit(setup.deps, { mealId: meals[0]!.mealId, action: "lock" });
    const view = await planControl(setup.deps, { planId, action: "resume" });
    expect(view.replaceable).toBe(2);
  });

  it("scopes to one day and to one meal", async () => {
    const { setup, planId, meals } = await planned(3);
    const before = meals.map((meal) => meal.recipeId);
    await planControl(setup.deps, { planId, action: "regenerate", date: "2026-11-03" });
    await drain(setup);
    expect(meals.map((meal) => meal.recipeId === before[meals.indexOf(meal)])).toEqual([
      true,
      false,
      true
    ]);

    const afterDay = meals.map((meal) => meal.recipeId);
    await planControl(setup.deps, { planId, action: "regenerate", mealId: meals[2]!.mealId });
    await drain(setup);
    expect(meals.map((meal) => meal.recipeId === afterDay[meals.indexOf(meal)])).toEqual([
      true,
      true,
      false
    ]);
  });

  it("does not rebuild the shopping list at reset time, so ticks survive", async () => {
    const { setup, planId } = await planned(1);
    const changes: string[] = [];
    const deps: PlanDeps = {
      ...setup.deps,
      onPlanChange: async (_id, change) => void changes.push(change)
    };
    await planControl(deps, { planId, action: "regenerate" });
    expect(changes).toEqual([]);
    await drain(setup, deps);
    expect(changes).toEqual(["written"]);
  });

  it("refuses when nothing can be replaced", async () => {
    const { setup, planId, meals } = await planned(1);
    await mealEdit(setup.deps, { mealId: meals[0]!.mealId, action: "lock" });
    await expect(planControl(setup.deps, { planId, action: "regenerate" })).rejects.toThrow(
      "nothing to replace"
    );
  });

  it("does not write the same dish again", async () => {
    const { setup, planId, meals } = await planned(1);
    const first = setup.store.recipes.get(meals[0]!.recipeId!)!.title;
    await planControl(setup.deps, { planId, action: "regenerate" });
    await drain(setup);
    expect(setup.store.recipes.get(meals[0]!.recipeId!)!.title).not.toBe(first);
  });
});

describe("Swap", () => {
  it("writes three choices, each passing Safety before it shows", async () => {
    const noPeanuts = member({ ...you, restrictions: ["peanut"] });
    const peanut = recipeAnswer({ title: "Satay", lines: ["2 tbsp peanut butter"] });
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([noPeanuts]), ai);
    const plan = await planCreate(setup.deps, {
      startDate: "2026-11-02",
      days: 1,
      idempotencyKey: "k"
    });
    await drain(setup);
    const meal = [...setup.store.meals.values()][0]!;

    ai.script("recipe", peanut);
    const asked = await mealSwap(setup.deps, { mealId: meal.mealId, action: "request_choices" });
    expect(asked.swapChoices.map((choice) => choice.status)).toEqual([
      "pending",
      "pending",
      "pending"
    ]);
    await drain(setup);

    const view = await mealGet(setup.deps, { mealId: meal.mealId });
    expect(view.swapChoices).toHaveLength(3);
    for (const choice of view.swapChoices) {
      expect(choice.status).toBe("ready");
      expect(choice.title).not.toBe("Satay");
      expect(choice.eaters.every((eater) => eater.safety === "pass")).toBe(true);
    }
    expect(new Set(view.swapChoices.map((choice) => choice.title)).size).toBe(3);
    expect(plan.planId).toBeTruthy();
  });

  it("never offers a dish someone eating the meal rated one star", async () => {
    const { setup, meals, planId } = await planned(1);
    // Repeats allowed, so only the one-star rule can keep the dish out.
    setup.store.plans.get(planId)!.allowRepeats = true;
    const meal = meals[0]!;
    const vetoed = "Satay";
    const deps: PlanDeps = {
      ...setup.deps,
      vetoes: async () => [{ memberId: you.memberId, title: vetoed, titleKey: titleKey(vetoed) }]
    };
    // The model answers with the one-star dish once, then something else.
    setup.ai.script("recipe", recipeAnswer({ title: vetoed }));
    await mealSwap(deps, { mealId: meal.mealId, action: "request_choices" });
    await drain(setup, deps);

    const view = await mealGet(deps, { mealId: meal.mealId });
    expect(view.swapChoices).toHaveLength(3);
    expect(view.swapChoices.map((choice) => choice.status)).toEqual(["ready", "ready", "ready"]);
    for (const choice of view.swapChoices) expect(choice.title).not.toBe(vetoed);
  });

  it("still offers a one-star dish when the plan's own request names it", async () => {
    const { setup, meals, planId } = await planned(1);
    const meal = meals[0]!;
    const plan = setup.store.plans.get(planId)!;
    plan.allowRepeats = true;
    plan.requestText = "satay night please";
    const vetoed = "Satay";
    const deps: PlanDeps = {
      ...setup.deps,
      vetoes: async () => [{ memberId: you.memberId, title: vetoed, titleKey: titleKey(vetoed) }]
    };
    setup.ai.script("recipe", recipeAnswer({ title: vetoed }));
    await mealSwap(deps, { mealId: meal.mealId, action: "request_choices" });
    await drain(setup, deps);

    const view = await mealGet(deps, { mealId: meal.mealId });
    expect(view.swapChoices[0]?.title).toBe(vetoed);
  });

  it("marks a choice failed when it cannot pass Safety", async () => {
    const { setup, meals } = await planned(1);
    const ai = setup.ai;
    ai.script("safety", {
      eaters: [
        { eater: 1, verdict: "fail", reason: "x" },
        { eater: 2, verdict: "pass", reason: null }
      ]
    });
    ai.script("safety", {
      eaters: [
        { eater: 1, verdict: "fail", reason: "x" },
        { eater: 2, verdict: "pass", reason: null }
      ]
    });
    ai.script("safety", {
      eaters: [
        { eater: 1, verdict: "fail", reason: "x" },
        { eater: 2, verdict: "pass", reason: null }
      ]
    });
    await mealSwap(setup.deps, { mealId: meals[0]!.mealId, action: "request_choices" });
    await drain(setup);
    const view = await mealGet(setup.deps, { mealId: meals[0]!.mealId });
    expect(view.swapChoices.map((choice) => choice.status)).toEqual(["failed", "ready", "ready"]);
  });

  it("replaces the meal on choose, rebuilds the list and clears the other choices", async () => {
    const { setup, meals } = await planned(1);
    const changes: string[] = [];
    const deps: PlanDeps = {
      ...setup.deps,
      onPlanChange: async (_id, change) => void changes.push(change)
    };
    const meal = meals[0]!;
    const oldRecipe = meal.recipeId;
    await mealSwap(deps, { mealId: meal.mealId, action: "request_choices" });
    await drain(setup, deps);
    const choices = (await mealGet(deps, { mealId: meal.mealId })).swapChoices;

    const chosen = await mealSwap(deps, {
      mealId: meal.mealId,
      action: "choose",
      choiceId: choices[1]!.choiceId
    });
    expect(chosen.meal.title).toBe(choices[1]!.title);
    expect(meal.recipeId).not.toBe(oldRecipe);
    expect(chosen.swapChoices).toEqual([]);
    expect(changes).toEqual(["written"]);
  });

  it("refuses a choice that is not ready", async () => {
    const { setup, meals } = await planned(1);
    await mealSwap(setup.deps, { mealId: meals[0]!.mealId, action: "request_choices" });
    const [pending] = (await mealGet(setup.deps, { mealId: meals[0]!.mealId })).swapChoices;
    await expect(
      mealSwap(setup.deps, {
        mealId: meals[0]!.mealId,
        action: "choose",
        choiceId: pending!.choiceId
      })
    ).rejects.toThrow("not ready");
  });

  it("gives a repeat request a new key, and the old job writes nothing", async () => {
    const { setup, meals } = await planned(1);
    const id = meals[0]!.mealId;
    await mealSwap(setup.deps, { mealId: id, action: "request_choices" });
    await mealSwap(setup.deps, { mealId: id, action: "request_choices" });
    const [first, second] = setup.jobs.calls;
    expect(first!.idempotencyKey).toBe(`meal-job:${id}:swap_choices:g1`);
    expect(second!.idempotencyKey).toBe(`meal-job:${id}:swap_choices:g2`);
    expect(await runMealJob(setup.deps, first!.params)).toEqual({ status: "stale" });
    expect(await runMealJob(setup.deps, second!.params)).toMatchObject({ status: "done" });
  });

  it("fails the choices and says why when the queue is limited", async () => {
    const { setup, meals } = await planned(1);
    setup.jobs.nextResult = "limited_hourly";
    await expect(
      mealSwap(setup.deps, { mealId: meals[0]!.mealId, action: "request_choices" })
    ).rejects.toThrow("hourly");
    const view = await mealGet(setup.deps, { mealId: meals[0]!.mealId });
    expect(view.swapChoices.every((choice) => choice.status === "failed")).toBe(true);
  });

  it("will not swap a cooked meal", async () => {
    const { setup, meals } = await planned(1);
    meals[0]!.cookedAt = "2026-11-02T18:00:00Z";
    await expect(
      mealSwap(setup.deps, { mealId: meals[0]!.mealId, action: "request_choices" })
    ).rejects.toThrow("cooked");
  });
});

describe("Meal job", () => {
  it("re-runs Safety for the current eaters and marks a failure with its reason", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer({ lines: ["2 tbsp peanut butter"] }))
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const { setup, meals } = await planned(1, ai);
    const meal = meals[0]!;
    expect(meal.eaters.every((eater) => eater.safety === "pass")).toBe(true);

    const allergic = member({ ...sam, restrictions: ["peanut"] });
    const deps: PlanDeps = { ...setup.deps, kitchen: async () => kitchenOf([you, allergic]) };
    const generation = (await setup.store.startMealJob(meal.mealId))!;
    const outcome = await runMealJob(deps, {
      mealId: meal.mealId,
      generation,
      mode: "safety_recheck"
    });
    expect(outcome).toEqual({ status: "done", mode: "safety_recheck" });
    const byId = new Map(meal.eaters.map((eater) => [eater.memberId, eater]));
    expect(byId.get(you.memberId)?.safety).toBe("pass");
    expect(byId.get(sam.memberId)?.safety).toBe("fail");
    expect(byId.get(sam.memberId)?.safetyReason).toBeTruthy();
  });

  it("treats a re-check for an old generation as stale and writes no verdicts", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer({ lines: ["2 tbsp peanut butter"] }))
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const { setup, meals } = await planned(1, ai);
    const meal = meals[0]!;

    // An old re-check is queued (generation 1), then a newer job raises the meal's generation to 2.
    const stale = (await setup.store.startMealJob(meal.mealId))!;
    await setup.store.startMealJob(meal.mealId);

    const allergic = member({ ...sam, restrictions: ["peanut"] });
    const deps: PlanDeps = { ...setup.deps, kitchen: async () => kitchenOf([you, allergic]) };
    const outcome = await runMealJob(deps, {
      mealId: meal.mealId,
      generation: stale,
      mode: "safety_recheck"
    });
    expect(outcome).toEqual({ status: "stale" });
    // The newer verdicts stand: Sam is still a pass, not the old job's peanut failure.
    expect(meal.eaters.find((eater) => eater.memberId === sam.memberId)?.safety).toBe("pass");
  });

  it("treats a re-check as stale when the meal's recipe changed under it", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const { setup, meals } = await planned(2, ai);
    const meal = meals[0]!;
    const generation = (await setup.store.startMealJob(meal.mealId))!;
    // Regenerate replaces the meal's recipe while the queued re-check is running.
    const replacement = meals[1]!.recipeId!;
    const readRecipes = setup.store.getRecipes.bind(setup.store);
    setup.store.getRecipes = async (ids) => {
      const rows = await readRecipes(ids);
      meal.recipeId = replacement;
      return rows;
    };

    const outcome = await runMealJob(setup.deps, {
      mealId: meal.mealId,
      generation,
      mode: "safety_recheck"
    });
    expect(outcome).toEqual({ status: "stale" });
  });

  it("rejects quick_swap until S9 and bad params", async () => {
    const { setup, meals } = await planned(1);
    const params = { mealId: meals[0]!.mealId, generation: 1 };
    await expect(runMealJob(setup.deps, { ...params, mode: "quick_swap" })).rejects.toThrow(
      "not available"
    );
    await expect(runMealJob(setup.deps, { ...params, mode: "nope" })).rejects.toThrow("bad mode");
    await expect(
      runMealJob(setup.deps, { ...params, generation: 0, mode: "swap_choices" })
    ).rejects.toThrow("bad generation");
  });

  it("registers the new handlers", () => {
    for (const key of ["meal.edit", "meal.swap", "meal.job"])
      expect(HANDLERS[key]).toBeTypeOf("function");
  });
});
