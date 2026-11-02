// tests/unit/external-module-meals-arrange.test.ts
//
// Meals phase 2 slice 8 (#3892): arrange the week. Move a meal, change who eats it, plain-text
// slots, One-off meals, a cook-time limit per night and a Shared or Solo override for one day.
// Against an in-memory store, a scripted model and a recording enqueue.

import { describe, expect, it } from "vitest";

import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { MEAL_JOB_QUEUE, type PlanDeps } from "../../external-modules/meals/src/plans/deps.js";
import { runMealJob } from "../../external-modules/meals/src/plans/meal-job.js";
import { dayEdit } from "../../external-modules/meals/src/plans/day-tools.js";
import { mealEdit } from "../../external-modules/meals/src/plans/meal-tools.js";
import { mealGet, planCreate, planControl } from "../../external-modules/meals/src/plans/tools.js";
import {
  listBuild,
  listEdit,
  listOnPlanChange
} from "../../external-modules/meals/src/lists/tools.js";
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
import { fakeListDeps } from "./helpers/meals-list-fake.js";

const you = member({
  memberId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "You",
  isSelf: true,
  calorieTarget: 1600,
  mealPattern: ["lunch", "dinner"]
});
const sam = member({
  memberId: "aaaaaaaa-0000-4000-8000-000000000002",
  name: "Sam",
  calorieTarget: 1600,
  mealPattern: ["lunch", "dinner"]
});

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

async function planned(days = 3, ai = happyAi()) {
  const setup = fakeDeps(kitchenOf([you, sam]), ai);
  const plan = await planCreate(setup.deps, {
    startDate: "2026-11-02",
    days,
    idempotencyKey: "plan-1"
  });
  await drain(setup);
  const byDate = (a: string, b: string) => a.localeCompare(b);
  const meals = [...setup.store.meals.values()].sort((a, b) =>
    byDate(setup.store.days.get(a.dayId)?.date ?? "", setup.store.days.get(b.dayId)?.date ?? "")
  );
  const dayList = [...setup.store.days.values()].sort((a, b) => byDate(a.date, b.date));
  return { setup, planId: plan.planId, meals, days: dayList };
}

describe("Move", () => {
  it("moves a meal to another day, rebuilds the list and keeps its ticks", async () => {
    const { setup, planId, meals, days } = await planned(3);
    const meal = meals.find((entry) => entry.slotName === "dinner")!;
    const target = days[2]!;

    const { deps: listDeps, lists } = fakeListDeps(setup.store, kitchenOf([you, sam]));
    const built = await listBuild(listDeps, { planId });
    const ticked = built.lines.find((line) => line.checkedAt === null && !line.manual)!;
    await listEdit(listDeps, { action: "tick", lineId: ticked.lineId });

    const changes: string[] = [];
    const deps: PlanDeps = {
      ...setup.deps,
      onPlanChange: async (id, change) => {
        changes.push(change);
        await listOnPlanChange(listDeps, id, change);
      }
    };
    const moved = await mealEdit(deps, {
      mealId: meal.mealId,
      action: "move",
      targetDayId: target.dayId
    });
    expect(setup.store.meals.get(meal.mealId)?.dayId).toBe(target.dayId);
    expect(moved.meal.title).toBeTruthy();
    expect(changes).toEqual(["written"]);

    const after = await listBuild(listDeps, { planId });
    const kept = after.lines.find((line) => line.lineId === ticked.lineId);
    expect(kept?.checkedAt).not.toBeNull();
    expect(lists).toBeTruthy();
  });

  it("can move a meal into another slot on the target day", async () => {
    const { setup, meals, days } = await planned(2);
    const dinner = meals.find((entry) => entry.slotName === "dinner")!;
    await mealEdit(setup.deps, {
      mealId: dinner.mealId,
      action: "move",
      targetDate: days[1]!.date,
      targetSlotName: "lunch"
    });
    const stored = setup.store.meals.get(dinner.mealId)!;
    expect(stored.dayId).toBe(days[1]!.dayId);
    expect(stored.slotName).toBe("lunch");
  });

  it("refuses to move a cooked meal or into a day of another plan", async () => {
    const { setup, meals } = await planned(2);
    const other = await planned(1);
    const cooked = meals[0]!;
    cooked.cookedAt = "2026-11-02T18:00:00Z";
    await expect(
      mealEdit(setup.deps, {
        mealId: cooked.mealId,
        action: "move",
        targetDayId: [...setup.store.days.values()][1]!.dayId
      })
    ).rejects.toThrow("cooked");
    await expect(
      mealEdit(setup.deps, {
        mealId: meals[1]!.mealId,
        action: "move",
        targetDayId: [...other.setup.store.days.values()][0]!.dayId
      })
    ).rejects.toThrow("another plan");
  });
});

describe("Change eaters", () => {
  it("re-runs Safety for the new eaters through the Safety re-check job", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer({ lines: ["2 tbsp peanut butter"] }))
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const { setup, meals } = await planned(1, ai);
    const meal = meals.find((entry) => entry.slotName === "dinner")!;

    // Sam stops eating this meal. Only the re-check can set the new eaters' Safety rows.
    const view = await mealEdit(setup.deps, {
      mealId: meal.mealId,
      action: "set_eaters",
      eaterIds: [you.memberId]
    });
    expect(view.meal.eaters.map((eater) => eater.memberId)).toEqual([you.memberId]);
    expect(view.meal.eaters[0]?.safety).toBe("pending");
    // Servings follow the eaters, not the old headcount.
    expect(view.meal.servings).toBe(view.meal.eaters[0]!.portion);
    const job = setup.jobs.calls.find((call) => call.queue === MEAL_JOB_QUEUE);
    expect(job?.params).toMatchObject({ mode: "safety_recheck", mealId: meal.mealId });

    // Sam is allergic now and rejoins. The re-check, not generation, must catch it.
    const allergicSam = member({ ...sam, restrictions: ["peanut"] });
    const deps: PlanDeps = { ...setup.deps, kitchen: async () => kitchenOf([you, allergicSam]) };
    setup.jobs.calls.length = 0;
    await mealEdit(deps, {
      mealId: meal.mealId,
      action: "set_eaters",
      eaterIds: [you.memberId, sam.memberId]
    });
    await drain(setup, deps);
    const after = await mealGet(deps, { mealId: meal.mealId });
    const byId = new Map(after.meal.eaters.map((eater) => [eater.memberId, eater]));
    expect(byId.get(you.memberId)?.safety).toBe("pass");
    expect(byId.get(sam.memberId)?.safety).toBe("fail");
  });

  it("refuses eaters who are not in the household and an empty list", async () => {
    const { setup, meals } = await planned(1);
    await expect(
      mealEdit(setup.deps, { mealId: meals[0]!.mealId, action: "set_eaters", eaterIds: [] })
    ).rejects.toThrow();
    await expect(
      mealEdit(setup.deps, {
        mealId: meals[0]!.mealId,
        action: "set_eaters",
        eaterIds: ["bbbbbbbb-0000-4000-8000-000000000099"]
      })
    ).rejects.toThrow("household");
  });
});

describe("Plain text slots", () => {
  it("turns a meal into text that never reaches the shopping list, and back again", async () => {
    const { setup, planId, meals } = await planned(2);
    const meal = meals.find((entry) => entry.slotName === "lunch")!;
    const day = await dayEdit(setup.deps, {
      mealId: meal.mealId,
      action: "set_text",
      text: "eating out"
    });
    expect(day.meals.find((entry) => entry.mealId === meal.mealId)?.kind).toBe("text");
    expect(day.meals.find((entry) => entry.mealId === meal.mealId)?.plainText).toBe("eating out");

    const { deps: listDeps } = fakeListDeps(setup.store, kitchenOf([you, sam]));
    const list = await listBuild(listDeps, { planId });
    expect(list.lines.flatMap((line) => line.sources.map((source) => source.mealId))).not.toContain(
      meal.mealId
    );

    const cleared = await dayEdit(setup.deps, { mealId: meal.mealId, action: "clear_text" });
    expect(cleared.meals.find((entry) => entry.mealId === meal.mealId)?.kind).toBe("recipe");
    await drain(setup);
    const restored = await mealGet(setup.deps, { mealId: meal.mealId });
    expect(restored.meal.status).toBe("ready");
    expect(restored.meal.title).toBeTruthy();
  });
});

describe("One-off meals", () => {
  it("adds a Solo meal for one member and has it written", async () => {
    const { setup, days } = await planned(2);
    const day = await dayEdit(setup.deps, {
      dayId: days[1]!.dayId,
      action: "add_one_off",
      slotName: "lunch",
      memberId: sam.memberId
    });
    const oneOff = day.meals.find((entry) => entry.oneOffFor === sam.memberId);
    expect(oneOff).toBeDefined();
    expect(oneOff?.sharing).toBe("solo");
    expect(oneOff?.eaters.map((eater) => eater.memberId)).toEqual([sam.memberId]);
    await drain(setup);
    const view = await mealGet(setup.deps, { mealId: oneOff!.mealId });
    expect(view.meal.status).toBe("ready");
    expect(view.meal.title).toBeTruthy();
  });
});

describe("Cook-time limit", () => {
  it("sets the limit, and regenerating that day writes a recipe inside it", async () => {
    const ai = new ScriptedAi()
      .always("recipe", recipeAnswer({ cookMinutes: 90 }))
      .always("safety", safetyPass(2))
      .always("estimate", ESTIMATE_800);
    const { setup, planId, days } = await planned(2, ai);
    const wednesday = days[1]!;
    const day = await dayEdit(setup.deps, {
      dayId: wednesday.dayId,
      action: "set_cook_limit",
      minutes: 20
    });
    expect(day.cookTimeLimitMinutes).toBe(20);

    ai.always("recipe", recipeAnswer({ cookMinutes: 15 }));
    await planControl(setup.deps, { planId, action: "regenerate", dayId: wednesday.dayId });
    await drain(setup);
    const after = [...setup.store.meals.values()].filter(
      (entry) => entry.dayId === wednesday.dayId
    );
    for (const entry of after) {
      expect(setup.store.recipes.get(entry.recipeId!)?.cookMinutes).toBeLessThanOrEqual(20);
    }
  });

  it("refuses a limit outside 5 to 240 minutes", async () => {
    const { setup, days } = await planned(1);
    await expect(
      dayEdit(setup.deps, { dayId: days[0]!.dayId, action: "set_cook_limit", minutes: 3 })
    ).rejects.toThrow();
  });
});

describe("Shared or Solo for one day", () => {
  it("a Solo override writes one meal per eater for that day only", async () => {
    const { setup, days, meals } = await planned(2);
    const day = await dayEdit(setup.deps, {
      dayId: days[0]!.dayId,
      action: "set_sharing",
      slotName: "dinner",
      sharing: "solo"
    });
    const dinners = day.meals.filter((entry) => entry.slotName === "dinner");
    expect(dinners).toHaveLength(2);
    for (const dinner of dinners) {
      expect(dinner.sharing).toBe("solo");
      expect(dinner.eaters).toHaveLength(1);
    }
    // The other day keeps its one shared dinner.
    const other = meals.filter(
      (entry) => entry.dayId === days[1]!.dayId && entry.slotName === "dinner"
    );
    expect(other).toHaveLength(1);
    expect(other[0]?.sharing).toBe("shared");
  });

  it("a Shared override joins the Solo meals of one slot back into one meal", async () => {
    const { setup, days } = await planned(1);
    await dayEdit(setup.deps, {
      dayId: days[0]!.dayId,
      action: "set_sharing",
      slotName: "dinner",
      sharing: "solo"
    });
    const day = await dayEdit(setup.deps, {
      dayId: days[0]!.dayId,
      action: "set_sharing",
      slotName: "dinner",
      sharing: "shared"
    });
    const dinners = day.meals.filter((entry) => entry.slotName === "dinner");
    expect(dinners).toHaveLength(1);
    expect(dinners[0]?.sharing).toBe("shared");
    expect(dinners[0]?.eaters.map((eater) => eater.memberId).sort()).toEqual(
      [sam.memberId, you.memberId].sort()
    );
  });
});

describe("Arrange handlers", () => {
  it("registers the day edit handler", () => {
    expect(HANDLERS["day.edit"]).toBeTypeOf("function");
  });
});
