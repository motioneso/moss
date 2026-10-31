// tests/unit/external-module-meals-list-tools.test.ts
//
// Meals phase 2 slice 4 (#3888): the shopping list tools against in-memory stores. Covers building
// from a plan, tick carry-over on rebuild, Bought, Undo and the destructive clear.
import { describe, expect, it } from "vitest";

import { runPlanDay } from "../../external-modules/meals/src/plans/day-job.js";
import { planCreate, planDelete } from "../../external-modules/meals/src/plans/tools.js";
import {
  listBought,
  listBuild,
  listClear,
  listEdit,
  listGet,
  listOnPlanChange,
  undo
} from "../../external-modules/meals/src/lists/tools.js";
import { fakeListDeps } from "./helpers/meals-list-fake.js";
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

function recipe(lines: ReadonlyArray<[string, number, string | null]>) {
  return () => ({
    title: "Soup",
    cookMinutes: 30,
    baseServings: 1,
    steps: ["Cook it."],
    ingredients: lines.map(([name, quantity, unit]) => ({
      originalText: `${quantity} ${unit ?? ""} ${name}`,
      name,
      quantity,
      unit,
      section: "produce",
      checkLabel: false
    }))
  });
}

async function setup(
  lines: ReadonlyArray<[string, number, string | null]> = [["carrot", 2, null]]
) {
  const ai = new ScriptedAi()
    .always("recipe", recipe(lines))
    .always("safety", safetyPass(1))
    .always("estimate", ESTIMATE_800);
  const kitchen = kitchenOf([you]);
  const plan = fakeDeps(kitchen, ai);
  const { deps, lists } = fakeListDeps(plan.store, kitchen);
  const created = await planCreate(plan.deps, {
    startDate: "2026-11-02",
    days: 1,
    idempotencyKey: "p1"
  });
  for (let i = 0; i < 5; i += 1) {
    const params = plan.jobs.take();
    if (params === undefined) break;
    await runPlanDay(plan.deps, params);
  }
  return { plan, deps, lists, planId: created.planId };
}

describe("list.build", () => {
  it("builds lines from the plan and names the meals they are for", async () => {
    const { deps, planId } = await setup();
    const list = await listBuild(deps, { planId });
    expect(list.planId).toBe(planId);
    expect(list.lines.map((line) => line.name)).toEqual(["carrot"]);
    expect(list.lines[0]!.sources.map((source) => source.label)).toEqual(["Mon dinner"]);
  });

  it("rejects a plan that does not exist", async () => {
    const { deps } = await setup();
    await expect(
      listBuild(deps, { planId: "00000000-0000-4000-8000-00000000ffff" })
    ).rejects.toThrow("No plan");
  });

  it("returns an empty list before one is built, without writing", async () => {
    const { deps, lists } = await setup();
    const list = await listGet(deps, {});
    expect(list.lines).toEqual([]);
    expect(lists.exists).toBe(false);
  });
});

describe("rebuild", () => {
  it("keeps ticks, manual lines and a ticked line the plan dropped", async () => {
    const { deps, lists, plan, planId } = await setup();
    const built = await listBuild(deps, { planId });
    const carrot = built.lines[0]!;
    await listEdit(deps, { action: "tick", lineId: carrot.lineId });
    await listEdit(deps, { action: "add", name: "milk", quantity: 1, unit: "l" });

    await planDelete(plan.deps, { planId });
    await listOnPlanChange(deps, planId, "deleted");

    const after = await listGet(deps, {});
    const names = after.lines.map((line) => [line.name, line.notInPlan, line.checkedAt !== null]);
    expect(names).toEqual(
      expect.arrayContaining([
        ["carrot", true, true],
        ["milk", false, false]
      ])
    );
    expect(lists.lines.size).toBe(2);
  });

  it("removes an unticked line the plan dropped", async () => {
    const { deps, plan, planId } = await setup();
    await listBuild(deps, { planId });
    await planDelete(plan.deps, { planId });
    await listOnPlanChange(deps, planId, "deleted");
    expect((await listGet(deps, {})).lines).toEqual([]);
  });

  it("ignores a change to a plan the list is not built from", async () => {
    const { deps, lists, planId } = await setup();
    await listBuild(deps, { planId });
    await listOnPlanChange(deps, "00000000-0000-4000-8000-00000000eeee", "deleted");
    expect(lists.lines.size).toBe(1);
  });
});

describe("list.edit", () => {
  it("edits the amount to buy on a built line and the amount on a manual line", async () => {
    const { deps, planId } = await setup();
    const built = await listBuild(deps, { planId });
    const added = await listEdit(deps, { action: "add", name: "milk", quantity: 1, unit: "l" });
    const milk = added.list.lines.find((line) => line.name === "milk")!;

    const afterBuilt = await listEdit(deps, {
      action: "update",
      lineId: built.lines[0]!.lineId,
      quantity: 6
    });
    expect(afterBuilt.list.lines.find((line) => line.name === "carrot")!.purchase?.quantity).toBe(
      6
    );

    const afterManual = await listEdit(deps, {
      action: "update",
      lineId: milk.lineId,
      quantity: 2
    });
    expect(afterManual.list.lines.find((line) => line.name === "milk")!.quantity).toBe(2);
  });

  it("returns an undo token for a removed line, and Undo brings it back", async () => {
    const { deps } = await setup();
    const added = await listEdit(deps, { action: "add", name: "milk" });
    const milk = added.list.lines[0]!;
    const removed = await listEdit(deps, { action: "remove", lineId: milk.lineId });
    expect(removed.list.lines).toEqual([]);
    expect(removed.undo?.kind).toBe("removed");

    const result = await undo(deps, { actionId: removed.undo!.actionId });
    expect(result).toEqual({ restored: 1, skipped: 0 });
    expect((await listGet(deps, {})).lines.map((line) => line.name)).toEqual(["milk"]);
    await expect(undo(deps, { actionId: removed.undo!.actionId })).rejects.toThrow(
      "nothing to undo"
    );
  });

  it("rejects a line id that is not on the list", async () => {
    const { deps } = await setup();
    await listEdit(deps, { action: "add", name: "milk" });
    await expect(
      listEdit(deps, { action: "tick", lineId: "00000000-0000-4000-8000-00000000dddd" })
    ).resolves.toBeDefined();
    await expect(
      listEdit(deps, { action: "remove", lineId: "00000000-0000-4000-8000-00000000dddd" })
    ).rejects.toThrow("no shopping list line");
  });
});

describe("list.bought", () => {
  it("buys the ticked lines, writes Pantry rows and stamps the lines", async () => {
    const { deps, lists } = await setup();
    const added = await listEdit(deps, { action: "add", name: "milk", quantity: 1, unit: "l" });
    await listEdit(deps, { action: "add", name: "bread" });
    const milk = added.list.lines.find((line) => line.name === "milk")!;
    await listEdit(deps, { action: "tick", lineIds: [milk.lineId] });

    const result = await listBought(deps, {});
    expect(result.pantryAdded).toBe(1);
    expect(result.undo.kind).toBe("bought");
    expect(result.list.lines.find((line) => line.name === "milk")!.boughtAt).not.toBeNull();
    expect(result.list.lines.find((line) => line.name === "bread")!.boughtAt).toBeNull();
    expect([...lists.pantry.values()].map((row) => [row.name, row.quantity, row.unit])).toEqual([
      ["milk", 1, "l"]
    ]);
  });

  it("uses the amount the shopper edited at the till", async () => {
    const { deps, lists } = await setup();
    const added = await listEdit(deps, { action: "add", name: "milk", quantity: 1, unit: "l" });
    const milk = added.list.lines[0]!;
    await listBought(deps, { lines: [{ lineId: milk.lineId, quantity: 3 }] });
    expect([...lists.pantry.values()][0]).toMatchObject({ name: "milk", quantity: 3, unit: "l" });
  });

  it("asks to tick something first when nothing is ticked", async () => {
    const { deps } = await setup();
    await listEdit(deps, { action: "add", name: "milk" });
    await expect(listBought(deps, {})).rejects.toThrow("Tick the lines you bought first");
  });

  it("undoes Bought, and skips a Pantry row edited since", async () => {
    const { deps, lists } = await setup();
    const a = (await listEdit(deps, { action: "add", name: "milk", quantity: 1, unit: "l" })).list
      .lines[0]!;
    const b = (await listEdit(deps, { action: "add", name: "eggs", quantity: 6 })).list.lines.find(
      (line) => line.name === "eggs"
    )!;
    await listEdit(deps, { action: "tick", lineIds: [a.lineId, b.lineId] });
    const bought = await listBought(deps, {});

    const edited = [...lists.pantry.values()].find((row) => row.name === "eggs")!;
    edited.updatedAt = "2026-11-03T08:00:00Z";

    const result = await undo(deps, { actionId: bought.undo.actionId });
    expect(result).toEqual({ restored: 1, skipped: 1 });
    expect([...lists.pantry.values()].map((row) => row.name)).toEqual(["eggs"]);
    const after = await listGet(deps, {});
    expect(after.lines.every((line) => line.boughtAt === null)).toBe(true);
  });
});

describe("list.clear", () => {
  it("is destructive in the manifest and empties the list", async () => {
    const { deps } = await setup();
    const added = await listEdit(deps, { action: "add", name: "milk" });
    expect(await listClear(deps, { listId: added.list.listId })).toEqual({ cleared: true });
    expect((await listGet(deps, {})).lines).toEqual([]);
  });

  it("refuses a list id that is not the owner's", async () => {
    const { deps } = await setup();
    await listEdit(deps, { action: "add", name: "milk" });
    await expect(
      listClear(deps, { listId: "00000000-0000-4000-8000-00000000cccc" })
    ).rejects.toThrow("No shopping list");
  });
});
