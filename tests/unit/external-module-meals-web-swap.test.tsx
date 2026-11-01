// @vitest-environment jsdom
//
// Meals S7 (#3891): lock, regenerate, swap and start-a-plan controls render through the real Root.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import { todayIso } from "../../external-modules/meals/src/web/format";
import { Root } from "../../external-modules/meals/src/web/root";

const eater = {
  memberId: "m1",
  name: "Rowan",
  portion: 1,
  safety: "pass",
  safetyReason: null,
  fit: { targetKcal: 700, estimatedKcal: 640, band: "on", differenceKcal: -60 }
};

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
  eaters: [eater],
  checkLabelCount: 0,
  cookedAt: null,
  ...overrides
});

const plan = (meals = [meal()], replaceable = 1) => ({
  planId: "p1",
  startDate: todayIso(),
  dayCount: 1,
  pantryMode: "prefer",
  state: "active",
  pausedReason: null,
  progress: { ready: 1, total: 1 },
  replaceable,
  days: [
    {
      dayId: "d1",
      date: todayIso(),
      status: "ready",
      failureReason: null,
      cookTimeLimitMinutes: null,
      dayFit: [],
      meals
    }
  ]
});

let current: () => unknown;
let recipe: () => unknown;

beforeEach(() => {
  mockReadTool.mockReset();
  current = () => ({ plan: plan() });
  recipe = () => ({ meal: meal(), swapChoices: [] });
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") {
      return { kitchenId: "k", members: [], slotRules: [], defaultPantryMode: "prefer" };
    }
    if (name === "meals.plan.current") return current();
    if (name === "meals.meal.get") return recipe();
    throw new Error(`unexpected tool ${name}`);
  });
});

async function render(path: string, props: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", path);
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
    (node) => node.type === "button" && flatten(node.props.children).trim() === label
  );

const okInvoke = () => vi.fn(async () => ({ status: "succeeded", result: {} }));

describe("Plan tab controls", () => {
  it("hides lock, swap and regenerate without a tools handle", async () => {
    const renderer = await render("/m/meals");
    expect(buttons(renderer, "Lock")).toHaveLength(0);
    expect(buttons(renderer, "Swap")).toHaveLength(0);
    expect(buttons(renderer, "Regenerate")).toHaveLength(0);
  });

  it("locks a meal through the edit tool", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Lock")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.edit", { mealId: "meal1", action: "lock" });
  });

  it("shows a Locked badge and offers Unlock", async () => {
    current = () => ({ plan: plan([meal({ locked: true })], 0) });
    const renderer = await render("/m/meals", { tools: { invoke: okInvoke() } });
    expect(text(renderer)).toContain("Locked");
    expect(buttons(renderer, "Unlock")).toHaveLength(1);
  });

  it("asks for swap choices, then opens the swap screen", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Swap")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.swap", {
      mealId: "meal1",
      action: "request_choices"
    });
    expect(window.location.pathname).toBe("/m/meals/plan/swap/meal1");
  });

  it("confirms with the replaced and kept counts before regenerating the plan", async () => {
    current = () => ({ plan: plan([meal(), meal({ mealId: "meal2", locked: true })], 1) });
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Regenerate")[0]!.props.onClick();
    });
    expect(text(renderer)).toContain("1 meal will be replaced.");
    expect(text(renderer)).toContain("1 locked meal stays.");
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      buttons(renderer, "Regenerate").at(-1)!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.plan.control", {
      action: "regenerate",
      planId: "p1"
    });
  });

  it("regenerates one meal by its id", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    const tools = renderer.root.find((node) => node.props.className === "mls-meal__tools");
    const mealButton = tools.findAll(
      (node) => node.type === "button" && flatten(node.props.children).trim() === "Regenerate"
    )[0]!;
    await act(async () => {
      mealButton.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.plan.control", {
      action: "regenerate",
      planId: "p1",
      mealId: "meal1"
    });
  });

  it("regenerates one day by its id", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Regenerate day")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.plan.control", {
      action: "regenerate",
      planId: "p1",
      dayId: "d1"
    });
  });
});

describe("Swap screen", () => {
  const withChoices = (statuses: string[]) => {
    recipe = () => ({
      meal: meal(),
      recipeId: "r1",
      baseServings: 2,
      servingsOverride: null,
      steps: [],
      ingredients: [],
      swapChoices: statuses.map((status, index) => ({
        choiceId: `c${index}`,
        status,
        title: status === "ready" ? `Option ${index}` : null,
        cookMinutes: status === "ready" ? 30 : null,
        eaters: status === "ready" ? [eater] : []
      }))
    });
  };

  it("shows a ready choice and chooses it", async () => {
    withChoices(["ready", "failed", "writing"]);
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/swap/meal1", { tools: { invoke } });
    expect(text(renderer)).toContain("Option 0");
    expect(text(renderer)).toContain("Moss could not write this one.");
    expect(buttons(renderer, "Find different options")).toHaveLength(0);
    await act(async () => {
      buttons(renderer, "Choose")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.swap", {
      mealId: "meal1",
      action: "choose",
      choiceId: "c0"
    });
  });

  it("offers to find different options once nothing is waiting", async () => {
    withChoices(["ready", "ready", "failed"]);
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/swap/meal1", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Find different options")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.swap", {
      mealId: "meal1",
      action: "request_choices"
    });
  });

  it("shows no Choose button without a tools handle", async () => {
    withChoices(["ready"]);
    const renderer = await render("/m/meals/plan/swap/meal1");
    expect(buttons(renderer, "Choose")).toHaveLength(0);
  });
});

describe("New plan screen", () => {
  it("starts a plan with a fresh key and the chosen length", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/new", { tools: { invoke } });
    const days = renderer.root.find(
      (node) => node.type === "input" && node.props.type === "number"
    );
    await act(async () => {
      days.props.onChange({ target: { value: "5" } });
    });
    await act(async () => {
      buttons(renderer, "Start the plan")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("meals.plan.create");
    expect(input).toMatchObject({ days: 5, pantryMode: "prefer", startDate: todayIso() });
    expect(String(input.idempotencyKey).length).toBeGreaterThan(8);
  });

  it("rejects a day count outside 1 to 28 without calling the tool", async () => {
    const invoke = okInvoke();
    const renderer = await render("/m/meals/plan/new", { tools: { invoke } });
    const days = renderer.root.find(
      (node) => node.type === "input" && node.props.type === "number"
    );
    await act(async () => {
      days.props.onChange({ target: { value: "40" } });
    });
    await act(async () => {
      buttons(renderer, "Start the plan")[0]!.props.onClick();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Days must be 1 to 28.");
  });
});
