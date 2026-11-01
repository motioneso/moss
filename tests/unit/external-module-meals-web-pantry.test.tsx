// @vitest-environment jsdom
//
// Meals S5 (#3889): the Pantry area renders through the real Root. Only ./api is mocked.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type { PantryView } from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";

const pantry = (overrides: Partial<PantryView> = {}): PantryView => ({
  items: [
    {
      itemId: "i1",
      name: "Basmati rice",
      quantity: 500,
      unit: "g",
      source: "bought",
      updatedAt: "2026-11-02T10:00:00Z"
    },
    {
      itemId: "i2",
      name: "Soy sauce",
      quantity: null,
      unit: null,
      source: "manual",
      updatedAt: "2026-11-02T10:00:00Z"
    }
  ],
  staples: [{ stapleId: "s1", name: "Salt" }],
  ...overrides
});

let current: PantryView;

beforeEach(() => {
  mockReadTool.mockReset();
  current = pantry();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    if (name === "meals.plan.current") return { plan: null };
    if (name === "meals.pantry.get") return current;
    throw new Error(`unexpected tool ${name}`);
  });
});

async function render(props: Record<string, unknown> = {}, path = "/m/meals/pantry") {
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
    (node) =>
      node.type === "button" &&
      (flatten(node.props.children).trim() === label || node.props["aria-label"] === label)
  );

describe("Pantry without a tools handle", () => {
  it("lists items with amounts, Some for no amount, and the Staples rail", async () => {
    const shown = text(await render());
    expect(shown).toContain("Basmati rice");
    expect(shown).toContain("500 g");
    expect(shown).toContain("Soy sauce");
    expect(shown).toContain("Some");
    expect(shown).toContain("Staples");
    expect(shown).toContain("Salt");
    expect(shown).toContain("2 items");
  });

  it("offers Ask Moss and no edit control", async () => {
    const renderer = await render();
    expect(buttons(renderer, "Ask Moss").length).toBeGreaterThan(0);
    expect(buttons(renderer, "Add item")).toEqual([]);
    expect(buttons(renderer, "Edit Basmati rice")).toEqual([]);
    expect(buttons(renderer, "Edit Staples")).toEqual([]);
  });

  it("shows the empty state when nothing is on hand", async () => {
    current = pantry({ items: [] });
    expect(text(await render())).toContain("The Pantry is empty");
  });

  it("shows the error state with Try again", async () => {
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.pantry.get") throw new Error("boom");
      if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
      return { plan: null };
    });
    const renderer = await render();
    expect(text(renderer)).toContain("Couldn't load the Pantry");
    expect(buttons(renderer, "Try again")).toHaveLength(1);
  });

  it("filters by the find box and says when nothing matches", async () => {
    const renderer = await render();
    const find = renderer.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Find an item"
    );
    await act(async () => {
      find.props.onChange({ target: { value: "soy" } });
    });
    expect(text(renderer)).toContain("Soy sauce");
    expect(text(renderer)).not.toContain("Basmati rice");
    await act(async () => {
      find.props.onChange({ target: { value: "zzz" } });
    });
    expect(text(renderer)).toContain("No item matches");
  });
});

describe("Pantry with a tools handle", () => {
  it("removes an item through the handle and offers Undo", async () => {
    const after = pantry({ items: [pantry().items[1]!] });
    const invoke = vi.fn(async () => ({
      status: "succeeded",
      result: { pantry: after, undo: { actionId: "a1", kind: "removed", count: 1 } }
    }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Remove Basmati rice")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.pantry.edit", {
      action: "remove",
      itemId: "i1"
    });
    expect(text(renderer)).toContain("Removed Basmati rice");
    expect(buttons(renderer, "Undo")).toHaveLength(1);
    expect(text(renderer)).not.toContain("500 g");
  });

  it("adds an item from the dialog with a blank amount as null", async () => {
    const invoke = vi.fn(async () => ({
      status: "succeeded",
      result: { pantry: current, undo: null }
    }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Add item")[0]!.props.onClick();
    });
    const name = renderer.root.find(
      (node) => node.type === "input" && node.props.placeholder === "Basmati rice"
    );
    await act(async () => {
      name.props.onChange({ target: { value: "Tahini" } });
    });
    await act(async () => {
      buttons(renderer, "Add")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.pantry.edit", {
      action: "add",
      name: "Tahini",
      quantity: null,
      unit: null
    });
  });

  it("refuses an amount that is not a number", async () => {
    const invoke = vi.fn();
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Edit Basmati rice")[0]!.props.onClick();
    });
    const amount = renderer.root.find(
      (node) => node.type === "input" && node.props.placeholder === "Optional"
    );
    await act(async () => {
      amount.props.onChange({ target: { value: "lots" } });
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Enter the amount as a number");
  });

  it("opens the Staples list on its own path and removes a Staple", async () => {
    const invoke = vi.fn(async () => ({
      status: "succeeded",
      result: { pantry: pantry({ staples: [] }), undo: null }
    }));
    const renderer = await render({ tools: { invoke } }, "/m/meals/pantry/staples");
    expect(text(renderer)).toContain("never go on the shopping list");
    await act(async () => {
      buttons(renderer, "Stop keeping Salt")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.pantry.edit", {
      action: "remove",
      target: "staple",
      stapleId: "s1"
    });
  });
});
