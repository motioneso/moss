// @vitest-environment jsdom
//
// Meals S10 (#3894): the cooking controls on the recipe screen render through the real Root.
// Only ./api is mocked, and the host write handle is a fake that records each call.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type { RecipeView } from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";

const recipe = (cookedAt: string | null = null): RecipeView => ({
  meal: {
    mealId: "meal1",
    slotName: "dinner",
    kind: "recipe",
    sharing: "shared",
    status: "ready",
    failureReason: null,
    locked: false,
    oneOffFor: null,
    favouriteOf: null,
    title: "Lemon chicken",
    plainText: null,
    cookMinutes: 30,
    servings: 2,
    eaters: [
      {
        memberId: "m1",
        name: "Rowan",
        portion: 1,
        safety: "pass",
        safetyReason: null,
        fit: null,
        rating: 4,
        favourite: false
      }
    ],
    checkLabelCount: 0,
    cookedAt
  },
  recipeId: "r1",
  baseServings: 2,
  servingsOverride: null,
  steps: ["Roast."],
  ingredients: [],
  swapChoices: []
});

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  mockReadTool.mockReset();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.meal.get") return recipe();
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    return { plan: null };
  });
});

async function render(withTools: boolean) {
  window.history.replaceState(null, "", "/m/meals/recipe/meal1");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(Root, {
        hostActions: { openAssistant: vi.fn() },
        ...(withTools ? { tools: { invoke } } : {})
      })
    );
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

const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label || flatten(node.props.children).trim() === label)
  );

describe("Recipe cooking controls", () => {
  it("shows no cooking controls without a tools handle", async () => {
    const renderer = await render(false);
    expect(button(renderer, "Mark cooked")).toEqual([]);
    expect(button(renderer, "More servings")).toEqual([]);
  });

  it("steps servings by half and rates with a toggle", async () => {
    invoke.mockResolvedValue({ status: "succeeded", result: recipe() });
    const renderer = await render(true);
    await act(async () => {
      await button(renderer, "More servings")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.servings", {
      mealId: "meal1",
      servings: 2.5
    });
    await act(async () => {
      await button(renderer, "4 stars for Rowan")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.meal.rate", {
      mealId: "meal1",
      ratings: [{ memberId: "m1", stars: null }]
    });
  });

  it("marks cooked, shows what it took, and offers Undo and a log", async () => {
    invoke.mockResolvedValue({
      status: "succeeded",
      result: {
        meal: recipe("2026-11-02T18:00:00.000Z").meal,
        pantryChanges: [{ name: "Rice", before: 500, after: 300, unit: "g" }],
        undo: { actionId: "a1", kind: "cooked", count: 1 },
        logOffer: { description: "Lemon chicken", servingNote: "1 serving" }
      }
    });
    const renderer = await render(true);
    await act(async () => {
      await button(renderer, "Mark cooked")[0]!.props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Rice 500 to 300 g");
    expect(button(renderer, "Undo")).toHaveLength(1);
    expect(button(renderer, "Log my portion")).toHaveLength(1);
    await act(async () => {
      await button(renderer, "Undo")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenLastCalledWith("meals.undo", { actionId: "a1" });
  });
});
