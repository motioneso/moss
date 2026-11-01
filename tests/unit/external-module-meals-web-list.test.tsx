// @vitest-environment jsdom
//
// Meals S4 (#3888): the Shopping list area renders through the real Root. Only ./api is mocked.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type { ListLineView, ShoppingListView } from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";

const line = (overrides: Partial<ListLineView> = {}): ListLineView => ({
  lineId: "l1",
  name: "carrot",
  quantity: 2,
  unit: null,
  purchase: null,
  section: "produce",
  manual: false,
  coveredByPantry: false,
  notInPlan: false,
  convertedFrom: [],
  sources: [{ mealId: "m1", label: "Mon dinner" }],
  checkedAt: null,
  boughtAt: null,
  ...overrides
});

const milk = (): ListLineView =>
  line({
    lineId: "l2",
    name: "milk",
    section: "dairy_eggs",
    quantity: 1,
    unit: "l",
    manual: true,
    sources: []
  });

const list = (lines: ListLineView[]): ShoppingListView => ({
  listId: "list1",
  planId: "p1",
  pantryMode: "prefer",
  lines
});

let current: ShoppingListView;

beforeEach(() => {
  mockReadTool.mockReset();
  current = list([line(), milk()]);
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    if (name === "meals.plan.current") return { plan: null };
    if (name === "meals.list.get") return current;
    throw new Error(`unexpected tool ${name}`);
  });
});

async function render(props: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", "/m/meals/list");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() }, ...props }));
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && "children" in (node as { children?: unknown })) {
    return flatten((node as { children?: unknown }).children);
  }
  return "";
}

const text = (renderer: ReactTestRenderer) =>
  flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();

const buttons = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      (flatten(node.props.children).trim() === label || node.props["aria-label"] === label)
  );

describe("Shopping list without a tools handle", () => {
  it("groups lines by section and names the meals they are for", async () => {
    const renderer = await render();
    const shown = text(renderer);
    expect(shown).toContain("Produce");
    expect(shown).toContain("Dairy and eggs");
    expect(shown).toContain("carrot");
    expect(shown).toContain("For Mon dinner");
    expect(shown).toContain("of 2 got");
  });

  it("offers Ask Moss and no edit control", async () => {
    const renderer = await render();
    expect(buttons(renderer, "Ask Moss").length).toBeGreaterThan(0);
    expect(buttons(renderer, "Add item")).toEqual([]);
    expect(buttons(renderer, "Edit carrot")).toEqual([]);
  });

  it("shows the error state with Try again", async () => {
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.list.get") throw new Error("boom");
      if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
      return { plan: null };
    });
    const renderer = await render();
    expect(text(renderer)).toContain("Couldn't load the shopping list");
    expect(buttons(renderer, "Try again")).toHaveLength(1);
  });

  it("keeps a ticked line that left the plan and says so", async () => {
    current = list([line({ notInPlan: true, checkedAt: "2026-11-02T10:00:00Z" })]);
    const renderer = await render();
    expect(text(renderer)).toContain("Not in the plan");
  });

  it("groups lines the Pantry covers apart from what to buy", async () => {
    current = list([line({ coveredByPantry: true }), milk()]);
    const renderer = await render();
    expect(text(renderer)).toContain("You have this");
    expect(text(renderer)).toContain("In the Pantry");
  });
});

describe("Shopping list with a tools handle", () => {
  it("ticks a line through the handle and shows the returned list", async () => {
    const invoke = vi.fn(async () => ({
      status: "succeeded",
      result: { list: list([line({ checkedAt: "2026-11-02T10:00:00Z" }), milk()]), undo: null }
    }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      renderer.root
        .find((node) => node.type === "input" && node.props["aria-label"] === "Got carrot")
        .props.onChange({ target: { checked: true } });
    });
    expect(invoke).toHaveBeenCalledWith("meals.list.edit", { action: "tick", lineId: "l1" });
    expect(text(renderer)).toContain("of 2 got");
  });

  it("offers Add item and Bought, and opens the Bought dialog", async () => {
    const invoke = vi.fn();
    const renderer = await render({ tools: { invoke } });
    expect(buttons(renderer, "Add item").length).toBeGreaterThan(0);
    await act(async () => {
      buttons(renderer, "Bought")[0]!.props.onClick();
    });
    expect(text(renderer)).toContain("Not ticked");
    expect(text(renderer)).toContain("Move to the Pantry");
  });

  it("offers Add item on an empty list", async () => {
    current = { ...list([]), planId: null };
    const invoke = vi.fn();
    const renderer = await render({ tools: { invoke } });
    expect(text(renderer)).toContain("Nothing to buy");
    expect(buttons(renderer, "Add item").length).toBeGreaterThan(0);
  });

  it("builds from the plan and shows the list the build returns", async () => {
    current = { ...list([]), planId: null };
    const readyPlan = {
      planId: "p1",
      startDate: "2026-11-02",
      dayCount: 1,
      pantryMode: "prefer",
      state: "active",
      pausedReason: null,
      progress: { ready: 1, total: 1 },
      days: [
        {
          dayId: "d1",
          date: "2026-11-02",
          status: "ready",
          failureReason: null,
          cookTimeLimitMinutes: null,
          dayFit: [],
          meals: [{ mealId: "m1", status: "ready" }]
        }
      ]
    };
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
      if (name === "meals.plan.current") return { plan: readyPlan };
      if (name === "meals.list.get") return current;
      throw new Error(`unexpected tool ${name}`);
    });
    // The build tool returns the list itself, not { list }.
    const invoke = vi.fn(async () => ({ status: "succeeded", result: list([line()]) }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Build from the plan")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.list.build", { planId: "p1" });
    expect(text(renderer)).toContain("carrot");
  });
});
