// tests/unit/external-module-meals-plan.test.ts
//
// Meals phase 2 slice 2 (#3886): the plan tools and the day job against an in-memory store, a
// scripted model and a recording enqueue. Assertions read records, never prompts.

import { describe, expect, it } from "vitest";

import type { AiFailure } from "../../external-modules/meals/src/ai/port.js";
import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import {
  mealGet,
  planControl,
  planCreate,
  planDelete,
  planGet
} from "../../external-modules/meals/src/plans/tools.js";
import type { MealsStore } from "../../external-modules/meals/src/store/sql.js";
import { createKitchenGetHandler } from "../../external-modules/meals/src/tools/household.js";
import {
  AiError,
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

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    startDate: "2026-11-02",
    days: 1,
    idempotencyKey: "plan-1",
    ...overrides
  };
}

type Setup = ReturnType<typeof fakeDeps>;

/** Runs queued day jobs one at a time, as the queue would, until none are left. */
async function drain({ deps, jobs }: Setup, limit = 40): Promise<void> {
  for (let run = 0; run < limit; run += 1) {
    const params = jobs.take();
    if (params === undefined) return;
    await runPlanDay(deps, params);
  }
  throw new Error("day jobs did not settle");
}

function mealsOf(setup: Setup) {
  return [...setup.store.meals.values()].sort((a, b) => {
    const dateA = setup.store.days.get(a.dayId)?.date ?? "";
    const dateB = setup.store.days.get(b.dayId)?.date ?? "";
    return dateA.localeCompare(dateB) || a.slotPosition - b.slotPosition;
  });
}

describe("Kitchen reads", () => {
  it("writes the Kitchen only from plan.create, so the read tools stay read-only", async () => {
    const setup = fakeDeps(kitchenOf([you, sam]), happyAi());
    const plan = await planCreate(setup.deps, createInput());
    expect(setup.kitchenWrites()).toBe(1);

    await drain(setup);
    await planGet(setup.deps, { planId: plan.planId });
    await planGet(setup.deps, { date: "2026-11-02" });
    await mealGet(setup.deps, { mealId: mealsOf(setup)[0]!.mealId });
    expect(setup.kitchenWrites()).toBe(1);
  });
});

describe("chaining days", () => {
  it("writes a 3-day plan one day at a time, in date order", async () => {
    const setup = fakeDeps(kitchenOf([you, sam]), happyAi());
    const plan = await planCreate(setup.deps, createInput({ days: 3 }));

    expect(setup.jobs.calls).toHaveLength(1);
    const keys: string[] = [];
    for (let run = 0; run < 3; run += 1) {
      const call = setup.jobs.calls[0];
      if (call === undefined) break;
      keys.push(call.idempotencyKey);
      await runPlanDay(setup.deps, setup.jobs.take()!);
      expect(setup.jobs.calls.length).toBeLessThanOrEqual(1);
    }

    const dayIds = plan.days.map((day) => day.dayId);
    expect(keys).toEqual(dayIds.map((dayId) => `plan-day:${dayId}:g1`));
    expect(setup.jobs.calls).toHaveLength(0);
    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after?.days.map((day) => day.status)).toEqual(["ready", "ready", "ready"]);
    expect(after?.progress).toEqual({ ready: 3, total: 3 });
  });

  it("carries only ids and a generation in job params", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    await planCreate(setup.deps, createInput({ requestText: "something spicy" }));
    const call = setup.jobs.calls[0];
    expect(call?.queue).toBe("meals.plan-day");
    expect(Object.keys(call?.params ?? {}).sort()).toEqual(["dayId", "generation", "planId"]);
    expect(call?.params["generation"]).toBe(1);
  });

  it("creates one plan per idempotency key", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const first = await planCreate(setup.deps, createInput());
    const second = await planCreate(setup.deps, createInput());
    expect(second.planId).toBe(first.planId);
    expect(setup.store.plans.size).toBe(1);
    expect(new Set(setup.jobs.calls.map((call) => call.idempotencyKey)).size).toBe(1);
  });

  it("refuses zero days and more than 28", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    await expect(planCreate(setup.deps, createInput({ days: 0 }))).rejects.toThrow();
    await expect(planCreate(setup.deps, createInput({ days: 29 }))).rejects.toThrow();
    expect(setup.store.plans.size).toBe(0);
  });
});

describe("saving each meal as it finishes", () => {
  const threeMeals = member({
    memberId: you.memberId,
    isSelf: true,
    mealPattern: ["breakfast", "lunch", "dinner"]
  });

  it("keeps meals 1 and 2 when meal 3 fails, and a retry writes only meal 3", async () => {
    const ai = new ScriptedAi()
      .script("recipe", recipeAnswer(), recipeAnswer(), new AiError("provider_error"))
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([threeMeals]), ai);
    const plan = await planCreate(setup.deps, createInput());
    await drain(setup);

    const [first, second, third] = mealsOf(setup);
    expect([first?.status, second?.status, third?.status]).toEqual(["ready", "ready", "failed"]);
    expect(third?.failureReason).toBe("provider_error");
    const day = await setup.store.getDay(plan.days[0]!.dayId);
    expect(day).toMatchObject({ status: "failed", failureReason: "provider_error" });

    const kept = [first?.recipeId, second?.recipeId];
    setup.store.readyLog.length = 0;
    await planControl(setup.deps, {
      planId: plan.planId,
      action: "retry_day",
      dayId: plan.days[0]!.dayId
    });
    await drain(setup);

    expect(setup.store.readyLog).toEqual([third?.mealId]);
    const after = mealsOf(setup);
    expect(after.map((meal) => meal.status)).toEqual(["ready", "ready", "ready"]);
    expect([after[0]?.recipeId, after[1]?.recipeId]).toEqual(kept);
  });

  it("finds the day to retry by its date", async () => {
    const ai = new ScriptedAi()
      .script("recipe", new AiError("aborted"))
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    await drain(setup);
    expect(plan.days.length).toBe(2);
    await planControl(setup.deps, {
      planId: plan.planId,
      action: "retry_day",
      date: "2026-11-02"
    });
    await drain(setup);
    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after?.days.map((day) => day.status)).toEqual(["ready", "ready"]);
  });
});

describe("one day at a time", () => {
  it("joins a retry to the running chain instead of writing two days at once", async () => {
    const ai = new ScriptedAi()
      .script("recipe", new AiError("provider_error"))
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    const plan = await planCreate(setup.deps, createInput({ days: 3 }));
    const [first, second, third] = plan.days.map((day) => day.dayId);

    await runPlanDay(setup.deps, setup.jobs.take()!);
    expect(setup.store.days.get(first!)?.status).toBe("failed");

    // Day 2's job has started: its day is claimed and writing.
    const secondJob = setup.jobs.take()!;
    expect(await setup.store.claimDay(second!, secondJob["generation"] as number)).toBe(true);

    await planControl(setup.deps, { planId: plan.planId, action: "retry_day", dayId: first });
    await runPlanDay(setup.deps, setup.jobs.take()!);
    expect(setup.store.days.get(first!)?.status).toBe("pending");
    expect(setup.jobs.calls).toHaveLength(0);

    const order: string[] = [];
    const run = async (params: Readonly<Record<string, unknown>>) => {
      order.push(params["dayId"] as string);
      await runPlanDay(setup.deps, params);
    };
    await run(secondJob);
    for (let next = setup.jobs.take(); next !== undefined; next = setup.jobs.take()) {
      await run(next);
    }
    expect(order).toEqual([second, first, third]);
    expect([...setup.store.days.values()].map((day) => day.status)).toEqual([
      "ready",
      "ready",
      "ready"
    ]);
  });
});

describe("generation", () => {
  it("writes nothing from a job whose generation is stale", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput());
    const stale = setup.jobs.take()!;
    await setup.store.bumpDay(plan.days[0]!.dayId);

    const outcome = await runPlanDay(setup.deps, stale);

    expect(outcome.status).toBe("stale");
    expect(setup.ai.calls).toHaveLength(0);
    expect(setup.store.readyLog).toHaveLength(0);
    expect(setup.jobs.calls).toHaveLength(0);
  });
});

describe("Stop", () => {
  it("stops before the next meal, not only between days", async () => {
    const twoMeals = member({
      memberId: you.memberId,
      isSelf: true,
      mealPattern: ["lunch", "dinner"]
    });
    const setup = fakeDeps(kitchenOf([twoMeals]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    let claims = 0;
    setup.store.beforeClaimMeal = () => {
      claims += 1;
      if (claims === 2) setup.store.plans.get(plan.planId)!.state = "stopped";
    };

    await runPlanDay(setup.deps, setup.jobs.take()!);

    const [first, second] = mealsOf(setup);
    expect(first?.status).toBe("ready");
    expect(second?.status).toBe("pending");
    expect(setup.store.readyLog).toHaveLength(1);
    expect(setup.jobs.calls).toHaveLength(0);
    expect((await setup.store.getDay(plan.days[0]!.dayId))?.status).toBe("pending");
  });

  it("is set by the stop action and resumed where it left off", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput({ days: 3 }));
    await runPlanDay(setup.deps, setup.jobs.take()!);
    const stopped = await planControl(setup.deps, { planId: plan.planId, action: "stop" });
    expect(stopped.state).toBe("stopped");

    await drain(setup);
    expect((await planGet(setup.deps, { planId: plan.planId }))?.progress.ready).toBe(1);

    const resumed = await planControl(setup.deps, { planId: plan.planId, action: "resume" });
    expect(resumed.state).toBe("active");
    await drain(setup);
    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after?.days.map((day) => day.status)).toEqual(["ready", "ready", "ready"]);
  });
});

describe("enqueue limits", () => {
  it("pauses the plan with the limit name, and resume enqueues with a new key", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    setup.jobs.nextResult = "limited_hourly";
    const plan = await planCreate(setup.deps, createInput());

    expect(plan.state).toBe("paused");
    expect(plan.pausedReason).toBe("hourly");
    const firstKey = setup.jobs.calls[0]?.idempotencyKey;
    setup.jobs.calls.length = 0;

    const resumed = await planControl(setup.deps, { planId: plan.planId, action: "resume" });
    expect(resumed.state).toBe("active");
    expect(resumed.pausedReason).toBeNull();
    const resumeKey = setup.jobs.calls[0]?.idempotencyKey;
    expect(resumeKey).toBeDefined();
    expect(resumeKey).not.toBe(firstKey);
    await drain(setup);
    expect((await planGet(setup.deps, { planId: plan.planId }))?.progress.ready).toBe(1);
  });

  it("pauses when the next day cannot be enqueued", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    const firstDay = setup.jobs.take()!;
    setup.jobs.nextResult = "limited_pending";
    await runPlanDay(setup.deps, firstDay);
    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after).toMatchObject({ state: "paused", pausedReason: "pending" });
    expect(after?.days.map((day) => day.status)).toEqual(["ready", "pending"]);
  });

  it("treats a duplicate next enqueue as success", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    const firstDay = setup.jobs.take()!;
    setup.jobs.nextResult = "duplicate";
    await runPlanDay(setup.deps, firstDay);
    expect(await planGet(setup.deps, { planId: plan.planId })).toMatchObject({
      state: "active",
      pausedReason: null
    });
  });

  it("writes the next day once when a finished day job runs again", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    await planCreate(setup.deps, createInput({ days: 2 }));
    const firstDay = setup.jobs.take()!;
    await runPlanDay(setup.deps, firstDay);
    await runPlanDay(setup.deps, firstDay);
    await drain(setup);
    expect(setup.store.readyLog).toHaveLength(2);
    expect(setup.ai.count("recipe")).toBe(2);
  });
});

describe("Safety", () => {
  const noPeanuts = member({ memberId: you.memberId, isSelf: true, restrictions: ["peanuts"] });
  const peanutRecipe = recipeAnswer({ lines: ["2 tbsp peanut butter", "1 cup rice"] });

  it("fails a peanut recipe without a model call and writes another", async () => {
    const ai = new ScriptedAi()
      .script("recipe", peanutRecipe)
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([noPeanuts]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);

    expect(ai.count("recipe")).toBe(2);
    expect(ai.count("safety")).toBe(1);
    const [meal] = mealsOf(setup);
    expect(meal?.status).toBe("ready");
    expect(meal?.eaters[0]?.safety).toBe("pass");
  });

  it("regenerates when the model fails an eater the rule passed", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .script("safety", {
        eaters: [{ eater: 1, verdict: "fail", reason: "Satay sauce contains peanuts" }]
      })
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([noPeanuts]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);
    expect(ai.count("recipe")).toBe(2);
    expect(mealsOf(setup)[0]?.status).toBe("ready");
  });

  it("regenerates when the model's answer leaves an eater out", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .script("safety", { eaters: [{ eater: 1, verdict: "pass" }] })
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you, sam]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);
    expect(ai.count("recipe")).toBe(2);
    expect(mealsOf(setup)[0]?.status).toBe("ready");
  });

  it("marks the eater failed when the model keeps failing, and stops at three attempts", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .always("safety", { eaters: [{ eater: 1, verdict: "fail", reason: "Fish sauce" }] })
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([noPeanuts]), ai);
    const plan = await planCreate(setup.deps, createInput());
    await drain(setup);

    expect(ai.count("recipe")).toBe(3);
    const [meal] = mealsOf(setup);
    expect(meal).toMatchObject({ status: "failed", failureReason: "safety_cap", attempts: 3 });
    expect(meal?.eaters[0]).toMatchObject({ safety: "fail", safetyReason: "Fish sauce" });
    expect((await setup.store.getDay(plan.days[0]!.dayId))?.failureReason).toBe("safety_cap");
  });

  it("keeps a rule failure even when the model would pass it", async () => {
    const ai = new ScriptedAi()
      .always("recipe", peanutRecipe)
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([noPeanuts]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);

    expect(ai.count("recipe")).toBe(3);
    expect(ai.count("safety")).toBe(0);
    const [meal] = mealsOf(setup);
    expect(meal).toMatchObject({ status: "failed", failureReason: "safety_cap" });
    expect(meal?.eaters[0]?.safety).toBe("fail");
  });

  it("counts a repeated dish against the same cap", async () => {
    const ai = new ScriptedAi()
      .script("recipe", recipeAnswer({ title: "Lentil soup" }))
      .always("recipe", recipeAnswer({ title: "Lentil Soup!" }))
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    await planCreate(setup.deps, createInput({ days: 2 }));
    await drain(setup);

    const [first, second] = mealsOf(setup);
    expect(first?.status).toBe("ready");
    expect(second).toMatchObject({ status: "failed", failureReason: "safety_cap" });
    expect(ai.count("recipe")).toBe(4);
  });

  it("allows a repeat when the plan asks for repeats", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer({ title: "Lentil soup" }))
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    await planCreate(setup.deps, createInput({ days: 2, allowRepeats: true }));
    await drain(setup);
    expect(mealsOf(setup).map((meal) => meal.status)).toEqual(["ready", "ready"]);
  });
});

describe("brand rule", () => {
  it("adds the check-the-label flag and never clears the model's", async () => {
    const answer = () => ({
      ...recipeAnswer({ lines: ["1 stock cube", "1 onion", "2 carrots"] })(),
      ingredients: [
        {
          originalText: "1 stock cube",
          name: "stock cube",
          quantity: 1,
          unit: null,
          section: "pantry",
          checkLabel: false
        },
        {
          originalText: "1 onion",
          name: "onion",
          quantity: 1,
          unit: null,
          section: "produce",
          checkLabel: true
        },
        {
          originalText: "2 carrots",
          name: "carrots",
          quantity: 2,
          unit: null,
          section: "produce",
          checkLabel: false
        }
      ]
    });
    const ai = new ScriptedAi()
      .always("recipe", answer)
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);

    const [meal] = mealsOf(setup);
    const recipe = setup.store.recipes.get(meal!.recipeId!);
    expect(recipe?.ingredients.map((line) => line.checkLabel)).toEqual([true, true, false]);
    const view = await mealGet(setup.deps, { mealId: meal!.mealId });
    expect(view?.meal.checkLabelCount).toBe(2);
  });
});

describe("AI errors", () => {
  const kinds: readonly AiFailure[] = [
    "needs_config",
    "validation_failed",
    "provider_error",
    "usage_limited",
    "aborted"
  ];

  it.each(kinds)("fails the meal and the day on %s, and reads keep working", async (kind) => {
    const ai = new ScriptedAi().always("recipe", new AiError(kind));
    const setup = fakeDeps(kitchenOf([you]), ai);
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    await drain(setup);

    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after?.days[0]).toMatchObject({ status: "failed", failureReason: kind });
    expect(after?.days[0]?.meals[0]).toMatchObject({ status: "failed", failureReason: kind });
    const kitchenGet = createKitchenGetHandler({
      readKitchen: setup.deps.kitchen
    } as unknown as MealsStore);
    await expect(kitchenGet({ input: {}, ai } as never)).resolves.toMatchObject({
      kitchenId: expect.any(String)
    });
    await expect(planGet(setup.deps, { date: "2026-11-02" })).resolves.toMatchObject({
      planId: plan.planId
    });
  });

  it("fails the day when the Safety call errors", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .always("safety", new AiError("usage_limited"));
    const setup = fakeDeps(kitchenOf([you]), ai);
    const plan = await planCreate(setup.deps, createInput());
    await drain(setup);
    expect((await setup.store.getDay(plan.days[0]!.dayId))?.failureReason).toBe("usage_limited");
  });

  it("fails the meal on a recipe the tables would refuse", async () => {
    const ai = new ScriptedAi().always("recipe", { title: "", steps: [] });
    const setup = fakeDeps(kitchenOf([you]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);
    expect(mealsOf(setup)[0]).toMatchObject({
      status: "failed",
      failureReason: "validation_failed"
    });
  });

  it("fails only that day and goes on to the next", async () => {
    const ai = new ScriptedAi()
      .script("recipe", new AiError("provider_error"))
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = fakeDeps(kitchenOf([you]), ai);
    const plan = await planCreate(setup.deps, createInput({ days: 2 }));
    await drain(setup);
    const after = await planGet(setup.deps, { planId: plan.planId });
    expect(after?.days.map((day) => day.status)).toEqual(["failed", "ready"]);
  });

  it("keeps the meal when only the calorie estimate fails", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer())
      .always("safety", safetyPass(1))
      .always("estimate", new AiError("provider_error"));
    const setup = fakeDeps(kitchenOf([you]), ai);
    await planCreate(setup.deps, createInput());
    await drain(setup);
    const [meal] = mealsOf(setup);
    expect(meal?.status).toBe("ready");
    expect(meal?.eaters[0]?.estimatedKcal).toBeNull();
  });
});

describe("tier hints", () => {
  it("writes and checks on the reasoning tier and estimates on the economy tier", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    await planCreate(setup.deps, createInput());
    await drain(setup);
    const hints = new Map(setup.ai.calls.map((call) => [call.kind, call.tierHint]));
    expect(Object.fromEntries(hints)).toEqual({
      recipe: "reasoning",
      safety: "reasoning",
      estimate: "economy"
    });
  });
});

describe("calorie fit", () => {
  it("sizes each eater's portion to their share and reports the fit", async () => {
    const target = member({
      memberId: you.memberId,
      name: "You",
      isSelf: true,
      calorieTarget: 2400,
      mealPattern: ["breakfast", "lunch", "dinner"]
    });
    const noTarget = member({ memberId: sam.memberId, name: "Sam", mealPattern: ["dinner"] });
    const setup = fakeDeps(kitchenOf([target, noTarget]), happyAi(2));
    const plan = await planCreate(setup.deps, createInput());
    await drain(setup);

    const view = await planGet(setup.deps, { planId: plan.planId });
    const dinner = view?.days[0]?.meals.find((meal) => meal.slotName === "dinner");
    // The 800 kcal recipe makes 2 servings; an 800 kcal share eats 2 of them.
    expect(dinner?.eaters.find((eater) => eater.name === "You")).toMatchObject({
      portion: 2,
      fit: { targetKcal: 800, estimatedKcal: 800, band: "on" }
    });
    expect(dinner?.eaters.find((eater) => eater.name === "Sam")).toMatchObject({
      portion: 1,
      fit: null
    });
    expect(dinner?.servings).toBe(3);
  });
});

describe("reading and deleting", () => {
  it("finds a plan by a date it covers", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput({ days: 3 }));
    await expect(planGet(setup.deps, { date: "2026-11-04" })).resolves.toMatchObject({
      planId: plan.planId
    });
    // The host refuses a tool result that is not an object, so "not found" is a refusal.
    await expect(planGet(setup.deps, { date: "2026-11-05" })).rejects.toThrow(/no plan/i);
  });

  it("shows a written meal as a recipe", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    await planCreate(setup.deps, createInput());
    await drain(setup);
    const [meal] = mealsOf(setup);
    const view = await mealGet(setup.deps, { mealId: meal!.mealId });
    expect(view?.meal.status).toBe("ready");
    expect(view?.steps.length).toBeGreaterThan(0);
    expect(view?.ingredients.map((line) => line.originalText)).toEqual(["1 cup rice", "2 carrots"]);
    expect(view?.baseServings).toBe(2);
  });

  it("deletes a plan", async () => {
    const setup = fakeDeps(kitchenOf([you]), happyAi(1));
    const plan = await planCreate(setup.deps, createInput());
    const [meal] = mealsOf(setup);
    await expect(planDelete(setup.deps, { planId: plan.planId })).resolves.toEqual({
      deleted: true
    });
    await expect(planGet(setup.deps, { planId: plan.planId })).rejects.toThrow(/no plan/i);
    await expect(mealGet(setup.deps, { mealId: meal!.mealId })).rejects.toThrow(/no meal/i);
    await drain(setup);
    expect(setup.ai.calls).toHaveLength(0);
  });
});
