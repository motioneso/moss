// @vitest-environment jsdom
//
// Meals S8 (#3892): move, eaters and text controls render through the real Root, and the day
// controls for the cook-time limit, sharing and a One-off meal.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import { addDays } from "../../external-modules/meals/src/domain/skeleton";
import { todayIso } from "../../external-modules/meals/src/web/format";
import { Root } from "../../external-modules/meals/src/web/root";

const eater = (id: string, name: string) => ({
  memberId: id,
  name,
  portion: 1,
  safety: "pass",
  safetyReason: null,
  fit: null,
  rating: null,
  favourite: false
});

const meal = (overrides: Record<string, unknown> = {}) => ({
  mealId: "meal1",
  slotName: "dinner",
  kind: "recipe",
  sharing: "shared",
  status: "ready",
  failureReason: null,
  locked: false,
  oneOffFor: null,
  favouriteOf: null,
  title: "Lemon chicken traybake",
  plainText: null,
  cookMinutes: 35,
  servings: 2,
  eaters: [eater("m1", "Rowan"), eater("m2", "Sam")],
  checkLabelCount: 0,
  cookedAt: null,
  ...overrides
});

const day = (dayId: string, date: string, meals: unknown[]) => ({
  dayId,
  date,
  status: "ready",
  failureReason: null,
  cookTimeLimitMinutes: null,
  dayFit: [],
  meals
});

const plan = () => ({
  planId: "p1",
  startDate: todayIso(),
  dayCount: 2,
  pantryMode: "prefer",
  state: "active",
  pausedReason: null,
  progress: { ready: 2, total: 2 },
  replaceable: 1,
  days: [
    day("d1", todayIso(), [meal()]),
    day("d2", addDays(todayIso(), 1), [meal({ mealId: "meal2", title: "Soup" })])
  ]
});

const kitchen = () => ({
  kitchenId: "k",
  unitsSystem: "us",
  defaultPantryMode: "prefer",
  members: [
    { memberId: "m1", name: "Rowan" },
    { memberId: "m2", name: "Sam" }
  ],
  slotRules: []
});

beforeEach(() => {
  mockReadTool.mockReset();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return kitchen();
    if (name === "meals.plan.current") return { plan: plan() };
    if (name === "meals.meal.get") {
      return {
        meal: meal(),
        recipeId: "r1",
        baseServings: 2,
        servingsOverride: null,
        steps: [],
        ingredients: [],
        swapChoices: []
      };
    }
    throw new Error(`unexpected tool ${name}`);
  });
});

async function render(path: string, props: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", path);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() }, ...props }));
  });
  for (let i = 0; i < 4; i += 1) {
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
    (node) => node.type === "button" && flatten(node.props.children).trim() === label
  );

const okInvoke = () => vi.fn(async () => ({ status: "succeeded", result: {} }));

describe("Plan tab arrange controls", () => {
  it("hides move, eaters and text without a tools handle", async () => {
    const renderer = await render("/m/meals");
    expect(buttons(renderer, "Move")).toHaveLength(0);
    expect(buttons(renderer, "Eaters")).toHaveLength(0);
    expect(buttons(renderer, "Text")).toHaveLength(0);
  });

  it("opens the move screen from a meal", async () => {
    const renderer = await render("/m/meals", { tools: { invoke: okInvoke() } });
    await act(async () => {
      buttons(renderer, "Move")[0]!.props.onClick();
    });
    expect(window.location.pathname).toBe("/m/meals/plan/move/meal1");
  });

  it("sets the cook-time limit for a day through the day tool", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    const select = renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"] === "Cook-time limit"
    )[0]!;
    await act(async () => {
      select.props.onChange({ target: { value: "20" } });
    });
    expect(invoke).toHaveBeenCalledWith("meals.day.edit", {
      dayId: "d1",
      action: "set_cook_limit",
      minutes: 20
    });
  });
});

describe("Move screen", () => {
  it("moves the meal to the picked day", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/move/meal1", { tools: { invoke } });
    expect(text(renderer)).toContain("Lemon chicken traybake");
    const dayButtons = renderer.root.findAll(
      (node) => node.type === "button" && node.props["data-day-id"] === "d2"
    );
    expect(dayButtons).toHaveLength(1);
    await act(async () => {
      dayButtons[0]!.props.onClick();
    });
    await act(async () => {
      buttons(renderer, "Move meal")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.edit", {
      mealId: "meal1",
      action: "move",
      targetDayId: "d2"
    });
    expect(window.location.pathname).toBe("/m/meals");
  });

  it("shows no Move meal button without a tools handle", async () => {
    const renderer = await render("/m/meals/plan/move/meal1");
    expect(buttons(renderer, "Move meal")).toHaveLength(0);
  });
});

describe("Eaters screen", () => {
  it("saves the picked eaters, and servings follow them", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/eaters/meal1", { tools: { invoke } });
    const boxes = renderer.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox"
    );
    expect(boxes).toHaveLength(2);
    await act(async () => {
      boxes[1]!.props.onChange({ target: { checked: false } });
    });
    await act(async () => {
      buttons(renderer, "Save eaters")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.edit", {
      mealId: "meal1",
      action: "set_eaters",
      eaterIds: ["m1"]
    });
  });
});

describe("Text screen", () => {
  it("sets the slot text through the day tool", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/text/meal1", { tools: { invoke } });
    const input = renderer.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Text for this meal"
    );
    await act(async () => {
      input.props.onChange({ target: { value: "eating out" } });
    });
    await act(async () => {
      buttons(renderer, "Save text")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.day.edit", {
      mealId: "meal1",
      action: "set_text",
      text: "eating out"
    });
  });
});
