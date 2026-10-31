// @vitest-environment jsdom
//
// Meals S1 (#3885): the page shell, Household and Settings render through the real Root. Only
// ./api is mocked. With no tools handle the page shows the household and no write control.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type { KitchenView, MemberView } from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";

function member(overrides: Partial<MemberView> & Pick<MemberView, "memberId" | "name">) {
  return {
    isSelf: false,
    linkedAccountEmail: null,
    calorieTarget: null,
    macroTargets: { proteinG: null, carbG: null, fatG: null },
    mealPattern: ["breakfast", "lunch", "dinner"],
    restrictions: [],
    preferences: [],
    favouriteRecipeIds: [],
    ...overrides
  } satisfies MemberView;
}

const KITCHEN: KitchenView = {
  kitchenId: "k1",
  unitsSystem: "metric",
  defaultPantryMode: "only",
  members: [
    member({ memberId: "m1", name: "You", isSelf: true, calorieTarget: 2200 }),
    member({
      memberId: "m2",
      name: "Sam",
      calorieTarget: 1800,
      restrictions: ["peanuts"],
      preferences: ["vegetarian"],
      mealPattern: ["lunch", "dinner"]
    })
  ],
  slotRules: [{ slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: null }]
};

beforeEach(() => {
  mockReadTool.mockReset();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return KITCHEN;
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

/** Every rendered element that writes: a marked control, or a button or input naming an edit. */
function writeControls(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === "string" &&
      (node.props["data-write"] !== undefined ||
        ((node.type === "button" || node.type === "input" || node.type === "select") &&
          /edit|add|remove|save|delete/i.test(
            `${flatten(node.props.children)} ${node.props["aria-label"] ?? ""}`
          )))
  );
}

describe("Meals page shell", () => {
  it("shows the five area tabs", async () => {
    const renderer = await render("/m/meals");
    const labels = renderer.root
      .findAll((node) => node.props.className === "jds-segmented__opt")
      .map((node) => flatten(node.props.children));
    expect(labels).toEqual(["Plan", "Shopping list", "Pantry", "Household", "Log"]);
  });

  it("gives each unbuilt area the prototype's empty-state title and no action", async () => {
    const titles: Array<[string, string]> = [
      ["/m/meals", "Plan your first week"],
      ["/m/meals/list", "Nothing to buy"],
      ["/m/meals/pantry", "The Pantry is empty"],
      ["/m/meals/log", "Nothing logged"]
    ];
    for (const [path, title] of titles) {
      const renderer = await render(path);
      const empty = renderer.root.find((node) => node.props.className === "jds-empty");
      expect(text(renderer)).toContain(title);
      expect(empty.findAll((node) => node.type === "button")).toEqual([]);
    }
  });

  it("numbers the household section heads like the prototype", async () => {
    const renderer = await render("/m/meals/household");
    const numbers = renderer.root
      .findAll((node) => node.props.className === "jds-section-head__number")
      .map((node) => flatten(node.props.children));
    expect(numbers).toEqual(["01", "02"]);
  });
});

describe("Household with no tools handle", () => {
  it("shows every member with Never serve, preferences and targets, and no edit control", async () => {
    const renderer = await render("/m/meals/household");
    const shown = text(renderer);
    expect(shown).toContain("You");
    expect(shown).toContain("Sam");
    expect(shown).toContain("peanuts");
    expect(shown).toContain("vegetarian");
    expect(shown).toContain("1,800");
    expect(shown).toContain("Lunch, Dinner");
    expect(writeControls(renderer)).toEqual([]);
  });

  it("shows the error state with Try again when the read fails", async () => {
    mockReadTool.mockRejectedValue(new Error("boom"));
    const renderer = await render("/m/meals/household");
    expect(text(renderer)).toContain("Couldn't load the household");
    expect(text(renderer)).toContain("Try again");
  });
});

describe("Settings with no tools handle", () => {
  it("shows units and Pantry mode, and no write control", async () => {
    const renderer = await render("/m/meals/settings");
    const shown = text(renderer);
    expect(shown).toContain("Metric");
    expect(shown).toContain("Only what's on hand");
    expect(writeControls(renderer)).toEqual([]);
  });
});

describe("Household with a tools handle", () => {
  it("removes a member through the handle, never through the read route", async () => {
    const invoke = vi.fn(async () => ({ status: "succeeded", result: { removed: true } }));
    const renderer = await render("/m/meals/household", { tools: { invoke } });
    const remove = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-label"] === "Remove Sam"
    );
    await act(async () => {
      remove.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.household.remove", { memberId: "m2" });
    expect(
      renderer.root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Remove You"
      )
    ).toEqual([]);
    expect(mockReadTool.mock.calls.every(([name]) => name === "meals.kitchen.get")).toBe(true);
  });
});
