// tests/unit/external-module-meals-cooking.test.ts
//
// Meals phase 2 slice 10 (#3894): servings, Mark cooked with Pantry subtraction and Undo, the
// log offer, ratings with the one-star near-veto, and favourites placed through Safety.
import { describe, expect, it } from "vitest";

import {
  favouritesEdit,
  mealCooked,
  mealRate,
  mealServings,
  type CookingDeps
} from "../../external-modules/meals/src/cooking/tools.js";
import { pantrySubtraction } from "../../external-modules/meals/src/domain/cooking.js";
import { undo } from "../../external-modules/meals/src/lists/tools.js";
import { pantryEdit, type PantryDeps } from "../../external-modules/meals/src/pantry/tools.js";
import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { planCreate } from "../../external-modules/meals/src/plans/tools.js";
import type { RecipeRow } from "../../external-modules/meals/src/store/plan-port.js";
import { FakeCookingStore } from "./helpers/meals-cooking-fake.js";
import { fakeListDeps } from "./helpers/meals-list-fake.js";
import { FakePantryStore } from "./helpers/meals-pantry-fake.js";
import {
  ESTIMATE_800,
  fakeDeps,
  kitchenOf,
  member,
  safetyPass,
  ScriptedAi
} from "./helpers/meals-plan-fake.js";

const you = member({
  memberId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "You",
  isSelf: true,
  mealPattern: ["dinner"]
});
const sam = member({
  memberId: "aaaaaaaa-0000-4000-8000-000000000002",
  name: "Sam",
  mealPattern: ["dinner"],
  restrictions: ["peanuts"]
});

function recipe(
  title: string,
  lines: readonly { name: string; quantity: number; unit: string | null }[]
) {
  return () => ({
    title,
    cookMinutes: 30,
    baseServings: 1,
    steps: ["Cook it."],
    ingredients: lines.map((line) => ({
      originalText: `${line.quantity} ${line.unit ?? ""} ${line.name}`.replace("  ", " "),
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      section: "pantry",
      checkLabel: false
    }))
  });
}

async function rig(
  members = [you],
  ai: ScriptedAi = new ScriptedAi()
    .always(
      "recipe",
      recipe("Rice bowl", [
        { name: "rice", quantity: 100, unit: "g" },
        { name: "onion", quantity: 2, unit: null },
        { name: "salt", quantity: 1, unit: "tsp" }
      ])
    )
    .always("safety", safetyPass(members.length))
    .always("estimate", ESTIMATE_800)
) {
  const kitchen = kitchenOf(members);
  const plan = fakeDeps(kitchen, ai);
  const { deps: listDeps, lists } = fakeListDeps(plan.store, kitchen);
  const pantry = new FakePantryStore(lists.undos);
  const cooking = new FakeCookingStore(plan.store, pantry, lists.undos);
  let tick = 0;
  const deps: CookingDeps = {
    ...plan.deps,
    marks: () => cooking.readMarks(),
    vetoes: (ids) => cooking.vetoes(ids),
    pantry,
    cooking,
    now: () => new Date(Date.UTC(2026, 10, 2, 18, 0, (tick += 1)))
  };
  const undoDeps = { ...listDeps, pantry, cooking };
  const pantryDeps: PantryDeps = {
    pantry,
    kitchen: async () => kitchen,
    ensureKitchen: async () => kitchen,
    newId: listDeps.newId
  };
  return { plan, deps, undoDeps, pantry, cooking, pantryDeps, kitchen };
}

async function writeDay(
  setup: Awaited<ReturnType<typeof rig>>,
  extra: { requestText?: string; key?: string } = {}
) {
  const created = await planCreate(setup.deps, {
    startDate: "2026-11-02",
    days: 1,
    pantryMode: "ignore",
    allowRepeats: true,
    idempotencyKey: extra.key ?? "p1",
    ...(extra.requestText ? { requestText: extra.requestText } : {})
  });
  for (let i = 0; i < 5; i += 1) {
    const params = setup.plan.jobs.take();
    if (params === undefined) break;
    await runPlanDay(setup.deps, params);
  }
  const meal = [...setup.plan.store.meals.values()].at(-1)!;
  return { planId: created.planId, mealId: meal.mealId, recipeId: meal.recipeId };
}

describe("pantry subtraction", () => {
  const stock = [
    { itemId: "i1", name: "Rice", quantity: 500, unit: "g" },
    { itemId: "i2", name: "Onion", quantity: 1, unit: null },
    { itemId: "i3", name: "Pasta", quantity: null, unit: null }
  ];
  const lines = [
    { name: "rice", quantity: 200, unit: "g" },
    { name: "onion", quantity: 2, unit: null },
    { name: "pasta", quantity: 100, unit: "g" },
    { name: "salt", quantity: 1, unit: "tsp" }
  ];

  it("scales to servings, converts units, never goes below zero and leaves have-some rows", () => {
    const changes = pantrySubtraction(lines, 2, stock, {
      mode: "prefer",
      stock: [],
      staples: ["salt"]
    });
    const rice = changes.find((c) => c.itemId === "i1")!;
    expect(rice.before).toBe(500);
    expect(rice.after).toBe(100);
    expect(changes.find((c) => c.itemId === "i2")).toMatchObject({ before: 1, after: 0 });
    expect(changes.some((c) => c.itemId === "i3")).toBe(false);
    expect(changes.every((c) => c.after >= 0)).toBe(true);
  });
});

describe("meals.meal.cooked", () => {
  it("takes the Pantry amounts scaled to the eaters, then Undo puts them back", async () => {
    const setup = await rig();
    const { mealId } = await writeDay(setup);
    const rice = setup.pantry.seed("Rice", 500, "g");
    const onion = setup.pantry.seed("Onion", 1, null);
    await mealServings(setup.deps, { mealId, servings: 2 });

    const result = await mealCooked(setup.deps, { mealId });
    expect(setup.pantry.items.get(rice)!.quantity).toBe(300);
    expect(setup.pantry.items.get(onion)!.quantity).toBe(0);
    expect(result.pantryChanges).toEqual(
      expect.arrayContaining([
        { name: "Rice", before: 500, after: 300, unit: "g" },
        { name: "Onion", before: 1, after: 0, unit: null }
      ])
    );
    expect(result.meal.cookedAt).not.toBeNull();
    expect(result.undo).toMatchObject({ kind: "cooked", count: 2 });

    const back = await undo(setup.undoDeps, { actionId: result.undo.actionId });
    expect(back).toEqual({ restored: 2, skipped: 0 });
    expect(setup.pantry.items.get(rice)!.quantity).toBe(500);
    expect(setup.plan.store.meals.get(mealId)!.cookedAt).toBeNull();
  });

  it("Undo skips a Pantry row edited since", async () => {
    const setup = await rig();
    const { mealId } = await writeDay(setup);
    const rice = setup.pantry.seed("Rice", 500, "g");
    setup.pantry.seed("Onion", 2, null);
    const result = await mealCooked(setup.deps, { mealId });

    await pantryEdit(setup.pantryDeps, { action: "update", itemId: rice, quantity: 50 });
    const back = await undo(setup.undoDeps, { actionId: result.undo.actionId });
    expect(back).toEqual({ restored: 1, skipped: 1 });
    expect(setup.pantry.items.get(rice)!.quantity).toBe(50);
  });

  it("cooks once, and offers to log one portion without logging it", async () => {
    const setup = await rig();
    const { mealId } = await writeDay(setup);
    const result = await mealCooked(setup.deps, { mealId });
    expect(result.logOffer).toEqual({ description: "Rice bowl", servingNote: "1 serving" });
    await expect(mealCooked(setup.deps, { mealId })).rejects.toThrow("already marked cooked");
  });
});

describe("meals.meal.servings", () => {
  it("steps in halves and scales the recipe", async () => {
    const setup = await rig();
    const { mealId } = await writeDay(setup);
    const view = await mealServings(setup.deps, { mealId, servings: 2.5 });
    expect(view.meal.servings).toBe(2.5);
    expect(view.ingredients.find((i) => i.name === "rice")!.display).toBe("250 g");
    await expect(mealServings(setup.deps, { mealId, servings: 2.3 })).rejects.toThrow("servings");
    const reset = await mealServings(setup.deps, { mealId, servings: null });
    expect(reset.meal.servings).toBe(1);
  });
});

describe("ratings and the near-veto", () => {
  it("shows ratings on the eater and clears them with null", async () => {
    const setup = await rig();
    const { mealId } = await writeDay(setup);
    const rated = await mealRate(setup.deps, {
      mealId,
      ratings: [{ memberId: you.memberId, stars: 4 }]
    });
    expect(rated.meal.eaters[0]!.rating).toBe(4);
    const cleared = await mealRate(setup.deps, {
      mealId,
      ratings: [{ memberId: you.memberId, stars: null }]
    });
    expect(cleared.meal.eaters[0]!.rating).toBeNull();
    await expect(
      mealRate(setup.deps, { mealId, ratings: [{ memberId: you.memberId, stars: 6 }] })
    ).rejects.toThrow("stars");
  });

  it("keeps a one-star recipe out of a plan with that person, unless a request names it", async () => {
    const setup = await rig();
    const first = await writeDay(setup);
    await mealRate(setup.deps, {
      mealId: first.mealId,
      ratings: [{ memberId: you.memberId, stars: 1 }]
    });

    // The model keeps offering the vetoed dish, so the day cannot be written.
    const blocked = await writeDay(setup, { key: "p2" });
    expect(setup.plan.store.meals.get(blocked.mealId)!.status).toBe("failed");

    const asked = await writeDay(setup, { key: "p3", requestText: "Make the Rice bowl again" });
    expect(setup.plan.store.meals.get(asked.mealId)!.status).toBe("ready");
  });
});

describe("favourites", () => {
  async function withFavourite(restrictions: string[] = []) {
    const peanut = recipe("Peanut stew", [{ name: "peanuts", quantity: 50, unit: "g" }]);
    const setup = await rig(
      [you, { ...sam, restrictions }],
      new ScriptedAi()
        .always("recipe", recipe("Rice bowl", [{ name: "rice", quantity: 100, unit: "g" }]))
        .always("safety", safetyPass(2))
        .always("estimate", ESTIMATE_800)
    );
    const day = await writeDay(setup);
    // A second recipe the household already cooked, kept as Sam's favourite.
    setup.plan.store.recipes.set("bbbbbbbb-0000-4000-8000-000000000001", {
      recipeId: "bbbbbbbb-0000-4000-8000-000000000001",
      title: "Peanut stew",
      titleKey: "peanut stew",
      steps: ["Stew."],
      cookMinutes: 20,
      baseServings: 2,
      kcalPerServing: 500,
      ingredients: peanut().ingredients as RecipeRow["ingredients"],
      kitchenId: setup.kitchen.kitchenId
    });
    return { setup, day, recipeId: "bbbbbbbb-0000-4000-8000-000000000001" };
  }

  it("adds and removes a favourite per person", async () => {
    const { setup, recipeId } = await withFavourite();
    const added = await favouritesEdit(setup.deps, {
      action: "add",
      memberId: sam.memberId,
      recipeId
    });
    expect(added.meal).toBeNull();
    expect(setup.cooking.favourites.size).toBe(1);
    await favouritesEdit(setup.deps, { action: "remove", memberId: sam.memberId, recipeId });
    expect(setup.cooking.favourites.size).toBe(0);
  });

  it("places a favourite into an unlocked slot only after Safety passes for every eater", async () => {
    const { setup, day, recipeId } = await withFavourite(["peanuts"]);
    await favouritesEdit(setup.deps, { action: "add", memberId: sam.memberId, recipeId });
    // Sam never eats peanuts, so the rule refuses before the model is asked.
    await expect(
      favouritesEdit(setup.deps, {
        action: "place",
        memberId: sam.memberId,
        recipeId,
        mealId: day.mealId
      })
    ).rejects.toThrow("Sam");
    expect(setup.cooking.placed).toEqual([]);
  });

  it("places a safe favourite and refuses a locked slot", async () => {
    const { setup, day, recipeId } = await withFavourite([]);
    await favouritesEdit(setup.deps, { action: "add", memberId: sam.memberId, recipeId });
    const safetyCalls = setup.plan.ai.count("safety");
    const placed = await favouritesEdit(setup.deps, {
      action: "place",
      memberId: sam.memberId,
      recipeId,
      mealId: day.mealId
    });
    expect(placed.meal).toMatchObject({ title: "Peanut stew", favouriteOf: sam.memberId });
    expect(setup.plan.ai.count("safety")).toBe(safetyCalls + 1);

    setup.plan.store.meals.get(day.mealId)!.locked = true;
    await expect(
      favouritesEdit(setup.deps, {
        action: "place",
        memberId: sam.memberId,
        recipeId,
        mealId: day.mealId
      })
    ).rejects.toThrow("locked");
  });
});
