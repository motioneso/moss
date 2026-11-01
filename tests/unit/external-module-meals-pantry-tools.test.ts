// tests/unit/external-module-meals-pantry-tools.test.ts
//
// Meals phase 2 slice 5 (#3889): the Pantry tools, the shared Undo for a removed item, the list
// that follows the Pantry, and the day job's "cook only from what I have" rule.
import { describe, expect, it } from "vitest";

import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { planCreate } from "../../external-modules/meals/src/plans/tools.js";
import {
  listBuild,
  listOnPantryChange,
  undo
} from "../../external-modules/meals/src/lists/tools.js";
import { pantryEdit, pantryGet } from "../../external-modules/meals/src/pantry/tools.js";
import type { PantryDeps } from "../../external-modules/meals/src/pantry/tools.js";
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
const kitchen = kitchenOf([you]);

class PromptAi extends ScriptedAi {
  readonly prompts: string[] = [];
  override async generateStructured(input: Parameters<ScriptedAi["generateStructured"]>[0]) {
    this.prompts.push(input.prompt);
    return super.generateStructured(input);
  }
}

function recipe(names: readonly string[]) {
  return () => ({
    title: `Dish with ${names.join(" and ")}`,
    cookMinutes: 30,
    baseServings: 1,
    steps: ["Cook it."],
    ingredients: names.map((name) => ({
      originalText: `1 ${name}`,
      name,
      quantity: 1,
      unit: null,
      section: "produce",
      checkLabel: false
    }))
  });
}

function rig(ai: ScriptedAi = new ScriptedAi()) {
  const plan = fakeDeps(kitchen, ai);
  const { deps: listDeps, lists } = fakeListDeps(plan.store, kitchen);
  const pantry = new FakePantryStore(lists.undos);
  const withPantry = { ...listDeps, pantry };
  const pantryDeps: PantryDeps = {
    pantry,
    kitchen: async () => kitchen,
    ensureKitchen: async () => kitchen,
    newId: listDeps.newId,
    onPantryChange: () => listOnPantryChange(withPantry)
  };
  return { plan, pantry, lists, listDeps: withPantry, pantryDeps };
}

async function writeOneDay(
  plan: ReturnType<typeof fakeDeps>,
  pantryMode: "ignore" | "prefer" | "only"
) {
  const created = await planCreate(plan.deps, {
    startDate: "2026-11-02",
    days: 1,
    pantryMode,
    idempotencyKey: `p-${pantryMode}`
  });
  for (let i = 0; i < 5; i += 1) {
    const params = plan.jobs.take();
    if (params === undefined) break;
    await runPlanDay(plan.deps, params);
  }
  return created;
}

describe("pantry.edit", () => {
  it("adds, updates and clears an amount", async () => {
    const { pantryDeps } = rig();
    const added = await pantryEdit(pantryDeps, {
      action: "add",
      name: "Rice",
      quantity: 500,
      unit: "g"
    });
    const itemId = added.pantry.items[0]!.itemId;
    expect(added.pantry.items[0]).toMatchObject({ name: "Rice", quantity: 500, unit: "g" });

    const some = await pantryEdit(pantryDeps, {
      action: "update",
      itemId,
      quantity: null,
      unit: null
    });
    expect(some.pantry.items[0]).toMatchObject({ quantity: null, unit: null });
    expect((await pantryGet(pantryDeps, {})).items).toHaveLength(1);
  });

  it("rejects a bad amount, an unknown id and unknown keys", async () => {
    const { pantryDeps } = rig();
    await expect(
      pantryEdit(pantryDeps, { action: "add", name: "Rice", quantity: 0 })
    ).rejects.toThrow("quantity");
    await expect(
      pantryEdit(pantryDeps, {
        action: "update",
        itemId: "00000000-0000-4000-8000-00000000ffff",
        name: "x"
      })
    ).rejects.toThrow("no Pantry item");
    await expect(
      pantryEdit(pantryDeps, { action: "add", name: "x", color: "red" })
    ).rejects.toThrow();
  });

  it("removing an item returns an Undo token that brings it back once", async () => {
    const { pantryDeps, listDeps, pantry } = rig();
    const itemId = pantry.seed("Lentils", 200, "g");

    const removed = await pantryEdit(pantryDeps, { action: "remove", itemId });
    expect(removed.pantry.items).toEqual([]);
    expect(removed.undo).toMatchObject({ kind: "removed", count: 1 });

    const first = await undo(listDeps, { actionId: removed.undo!.actionId });
    expect(first).toEqual({ restored: 1, skipped: 0 });
    expect((await pantryGet(pantryDeps, {})).items[0]).toMatchObject({
      name: "Lentils",
      quantity: 200
    });
    await expect(undo(listDeps, { actionId: removed.undo!.actionId })).rejects.toThrow(
      "nothing to undo"
    );
  });

  it("keeps Staples apart from items, refuses a duplicate rename, and never lists one twice", async () => {
    const { pantryDeps } = rig();
    await pantryEdit(pantryDeps, { action: "add", target: "staple", name: "Salt" });
    await pantryEdit(pantryDeps, { action: "add", target: "staple", name: "salt" });
    const both = await pantryEdit(pantryDeps, {
      action: "add",
      target: "staple",
      name: "Olive oil"
    });
    expect(both.pantry.staples.map((s) => s.name).sort()).toEqual(["Olive oil", "Salt"]);
    expect(both.pantry.items).toEqual([]);

    const oil = both.pantry.staples.find((s) => s.name === "Olive oil")!;
    await expect(
      pantryEdit(pantryDeps, {
        action: "update",
        target: "staple",
        stapleId: oil.stapleId,
        name: "Salt"
      })
    ).rejects.toThrow("already on the list");
  });
});

describe("the list follows the Pantry", () => {
  async function planned(mode: "ignore" | "prefer") {
    const ai = new ScriptedAi()
      .always("recipe", recipe(["rice", "salt", "saffron"]))
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const setup = rig(ai);
    const created = await writeOneDay(setup.plan, mode);
    return { ...setup, planId: created.planId };
  }

  it("ignore lists every ingredient except nothing is hidden", async () => {
    const { listDeps, pantry, planId } = await planned("ignore");
    pantry.seed("Rice");
    const list = await listBuild(listDeps, { planId });
    expect(list.lines.filter((l) => l.coveredByPantry)).toEqual([]);
    expect(list.lines.map((l) => l.name).sort()).toEqual(["rice", "saffron", "salt"]);
  });

  it("prefer moves covered lines to You have this and drops Staples", async () => {
    const { listDeps, pantry, pantryDeps, planId } = await planned("prefer");
    pantry.seed("Rice");
    await pantryEdit(pantryDeps, { action: "add", target: "staple", name: "Salt" });
    const list = await listBuild(listDeps, { planId });
    expect(list.lines.find((l) => l.name === "rice")!.coveredByPantry).toBe(true);
    expect(list.lines.find((l) => l.name === "saffron")!.coveredByPantry).toBe(false);
    expect(list.lines.find((l) => l.name === "salt")).toBeUndefined();
  });

  it("rebuilds the list when a removed item is brought back", async () => {
    const { listDeps, pantry, pantryDeps, planId } = await planned("prefer");
    const itemId = pantry.seed("Rice");
    await listBuild(listDeps, { planId });
    const line = async () => (await listDeps.lists.readList()).lines.find((l) => l.name === "rice");
    expect((await line())?.coveredByPantry).toBe(true);

    const removed = await pantryEdit(pantryDeps, { action: "remove", itemId });
    expect((await line())?.coveredByPantry).toBe(false);

    await undo(listDeps, { actionId: removed.undo!.actionId });
    expect((await line())?.coveredByPantry).toBe(true);
  });

  it("rebuilds the list when the Pantry changes", async () => {
    const { listDeps, pantryDeps, planId } = await planned("prefer");
    await listBuild(listDeps, { planId });
    await pantryEdit(pantryDeps, { action: "add", name: "Saffron" });
    const after = await listDeps.lists.readList();
    const saffron = after.lines.find((l) => l.name === "saffron");
    expect(saffron?.coveredByPantry).toBe(true);
  });
});

describe("the day job and the Pantry mode", () => {
  it("sends what is on hand to the recipe prompt in prefer and only, and nothing in ignore", async () => {
    for (const [mode, expected] of [
      ["ignore", false],
      ["prefer", true],
      ["only", true]
    ] as const) {
      const ai = new PromptAi()
        .always("recipe", recipe(["rice"]))
        .always("safety", safetyPass(1))
        .always("estimate", ESTIMATE_800);
      const { plan, pantry } = rig(ai);
      pantry.seed("Rice");
      plan.deps = { ...plan.deps, pantry } as typeof plan.deps;
      await writeOneDay(plan, mode);
      const recipePrompt = ai.prompts[0];
      expect(recipePrompt?.includes("On hand")).toBe(expected);
    }
  });

  it("only mode rejects a recipe that needs something else and writes the next one", async () => {
    const ai = new PromptAi()
      .script("recipe", recipe(["rice", "saffron"]), recipe(["rice"]))
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const { plan, pantry } = rig(ai);
    pantry.seed("Rice");
    plan.deps = { ...plan.deps, pantry } as typeof plan.deps;
    await writeOneDay(plan, "only");

    expect(ai.count("recipe")).toBe(2);
    const meals = [...plan.store.meals.values()];
    expect(meals.map((m) => m.status)).toEqual(["ready"]);
  });

  it("only mode fails the meal when every try needs something else", async () => {
    const ai = new PromptAi()
      .always("recipe", recipe(["rice", "saffron"]))
      .always("safety", safetyPass(1))
      .always("estimate", ESTIMATE_800);
    const { plan, pantry } = rig(ai);
    pantry.seed("Rice");
    plan.deps = { ...plan.deps, pantry } as typeof plan.deps;
    await writeOneDay(plan, "only");

    const meals = [...plan.store.meals.values()];
    expect(meals.map((m) => m.status)).toEqual(["failed"]);
    expect(meals[0]!.failureReason).toBe("validation_failed");
  });
});
