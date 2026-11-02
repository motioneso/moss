// @vitest-environment jsdom
//
// Meals S3 (#3887): the Plan tab and recipe view render through the real Root. Only ./api is mocked.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type {
  EaterView,
  PlanDayView,
  PlannedMealView,
  PlanView,
  RecipeView
} from "../../external-modules/meals/src/contracts";
import { todayIso } from "../../external-modules/meals/src/web/format";
import { Root } from "../../external-modules/meals/src/web/root";

const eater = (overrides: Partial<EaterView> = {}): EaterView => ({
  memberId: "m1",
  name: "Rowan",
  portion: 1,
  safety: "pass",
  safetyReason: null,
  fit: { targetKcal: 700, estimatedKcal: 640, band: "on", differenceKcal: -60 },
  rating: null,
  favourite: false,
  ...overrides
});

const meal = (overrides: Partial<PlannedMealView> = {}): PlannedMealView => ({
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
  eaters: [eater()],
  checkLabelCount: 0,
  cookedAt: null,
  ...overrides
});

const day = (overrides: Partial<PlanDayView> = {}): PlanDayView => ({
  dayId: "d1",
  date: todayIso(),
  status: "ready",
  failureReason: null,
  cookTimeLimitMinutes: null,
  meals: [meal()],
  dayFit: [],
  ...overrides
});

const plan = (overrides: Partial<PlanView> = {}): PlanView => ({
  planId: "p1",
  startDate: todayIso(),
  dayCount: 1,
  pantryMode: "prefer",
  state: "active",
  pausedReason: null,
  progress: { ready: 1, total: 1 },
  replaceable: 1,
  days: [day()],
  ...overrides
});

let current: () => unknown;

beforeEach(() => {
  mockReadTool.mockReset();
  current = () => ({ plan: plan() });
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    if (name === "meals.plan.current") return current();
    throw new Error(`unexpected tool ${name}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function render(path = "/m/meals", props: Record<string, unknown> = {}) {
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

describe("Meals Plan tab", () => {
  it("shows the empty state with a way to start when nothing is planned", async () => {
    current = () => ({ plan: null });
    const renderer = await render();
    expect(text(renderer)).toContain("Plan your first week");
    expect(text(renderer)).toContain("Plan with Moss");
  });

  it("shows a loading line while the plan loads", async () => {
    mockReadTool.mockImplementation(() => new Promise(() => {}));
    window.history.replaceState(null, "", "/m/meals");
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Root, { hostActions: { openAssistant: vi.fn() } }));
    });
    expect(text(renderer)).toContain("Loading your plan");
  });

  it("shows a recovery tile when the plan cannot load", async () => {
    current = () => {
      throw new Error("down");
    };
    const renderer = await render();
    expect(text(renderer)).toContain("Couldn't load your plan");
    expect(text(renderer)).toContain("Try again");
  });

  it("shows tonight's dinner and the written meal", async () => {
    const renderer = await render();
    expect(text(renderer)).toContain("Lemon chicken traybake");
    expect(text(renderer)).toContain("640 / 700");
    expect(text(renderer)).toContain("Serves 2");
  });

  it("reminds the user to double check even when every check passed", async () => {
    const renderer = await render();
    expect(text(renderer)).toContain("Nothing from the Never serve list was found outright.");
    expect(text(renderer)).toContain("Always double check.");
    expect(text(renderer)).not.toMatch(/\bsafe\b/i);
  });

  it("words a failed check as found, never as unsafe, and still reminds", async () => {
    current = () => ({
      plan: plan({
        days: [
          day({ meals: [meal({ eaters: [eater({ safety: "fail", safetyReason: "peanut" })] })] })
        ]
      })
    });
    const renderer = await render();
    expect(text(renderer)).toContain("Found something from the Never serve list for Rowan.");
    expect(text(renderer)).toContain("Always double check.");
    expect(text(renderer)).not.toMatch(/\bsafe\b/i);
  });

  it("holds back a meal until its Safety result is known", async () => {
    current = () => ({
      plan: plan({ days: [day({ meals: [meal({ eaters: [eater({ safety: "pending" })] })] })] })
    });
    const renderer = await render();
    expect(text(renderer)).not.toContain("Lemon chicken traybake");
    expect(text(renderer)).toContain("Waiting");
  });

  it("shows a placeholder for a day still being written", async () => {
    current = () => ({
      plan: plan({
        progress: { ready: 0, total: 1 },
        days: [day({ status: "writing", meals: [meal({ status: "writing", title: null })] })]
      })
    });
    const renderer = await render();
    expect(text(renderer)).toContain("Writing");
  });

  it("shows why a failed day failed", async () => {
    current = () => ({
      plan: plan({
        days: [day({ status: "failed", failureReason: "usage_limited", meals: [] })]
      })
    });
    const renderer = await render();
    expect(text(renderer)).toContain("The AI service hit its usage limit.");
  });

  it("shows no write control without the host's write handle", async () => {
    current = () => ({
      plan: plan({
        progress: { ready: 0, total: 1 },
        days: [
          day({ status: "failed", failureReason: "timeout", meals: [] }),
          day({ dayId: "d2", status: "writing", meals: [] })
        ]
      })
    });
    const renderer = await render();
    const buttons = renderer.root.findAll((node) => node.type === "button");
    const labels = buttons.map((node) => flatten(node.props.children));
    expect(labels).not.toContain("Retry");
    expect(labels).not.toContain("Stop");
    expect(labels).not.toContain("Resume");
  });

  it("polls while Moss is writing and stops once the plan is finished", async () => {
    vi.useFakeTimers();
    let calls = 0;
    current = () => {
      calls += 1;
      return calls < 2
        ? {
            plan: plan({
              progress: { ready: 0, total: 1 },
              days: [day({ status: "writing", meals: [] })]
            })
          }
        : { plan: plan() };
    };
    await render();
    const afterFirst = mockReadTool.mock.calls.filter((c) => c[0] === "meals.plan.current").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    const afterPoll = mockReadTool.mock.calls.filter((c) => c[0] === "meals.plan.current").length;
    expect(afterPoll).toBeGreaterThan(afterFirst);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    const afterDone = mockReadTool.mock.calls.filter((c) => c[0] === "meals.plan.current").length;
    expect(afterDone).toBe(afterPoll);
  });
});

describe("Meals recipe view", () => {
  it("shows the ingredients with the original line and the method", async () => {
    const recipe: RecipeView = {
      meal: meal(),
      recipeId: "r1",
      baseServings: 2,
      servingsOverride: null,
      steps: ["Heat the oven.", "Roast the chicken."],
      ingredients: [
        {
          originalText: "2 chicken thighs, skin on",
          name: "chicken thighs",
          quantity: 2,
          unit: null,
          display: "2",
          section: "meat" as never,
          checkLabel: false,
          missing: false
        }
      ],
      swapChoices: []
    };
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.meal.get") return recipe;
      if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
      return { plan: null };
    });
    const renderer = await render("/m/meals/recipe/meal1");
    const shown = text(renderer);
    expect(shown).toContain("Lemon chicken traybake");
    expect(shown).toContain("As written: 2 chicken thighs, skin on");
    expect(shown).toContain("Roast the chicken.");
    expect(shown).toContain("Back to the plan");
  });
});
