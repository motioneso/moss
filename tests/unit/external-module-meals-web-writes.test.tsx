// @vitest-environment jsdom
//
// Meals S11 (#3895): every page write goes through the host's tools handle, each outcome shows
// its own message, and the destructive controls (delete plan, clear list) call their tools.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type { ListLineView, ShoppingListView } from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";
import { bindWrites, noticeFor } from "../../external-modules/meals/src/web/writes";

const line = (): ListLineView => ({
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
  boughtAt: null
});
const LIST: ShoppingListView = {
  listId: "list1",
  planId: "p1",
  pantryMode: "prefer",
  lines: [line()]
};
const PLAN = {
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
      meals: []
    }
  ]
};

beforeEach(() => {
  mockReadTool.mockReset();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    if (name === "meals.plan.current") return { plan: PLAN };
    if (name === "meals.list.get") return LIST;
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
  if (typeof node === "object" && "children" in (node as { children?: unknown }))
    return flatten((node as { children?: unknown }).children);
  return "";
}
const text = (r: ReactTestRenderer) => flatten(r.toJSON()).replace(/\s+/g, " ").trim();
const buttons = (r: ReactTestRenderer, label: string) =>
  r.root.findAll(
    (n) =>
      n.type === "button" &&
      (flatten(n.props.children).trim() === label || n.props["aria-label"] === label)
  );

describe("the write adapter", () => {
  it("passes the host's saved outcome through", async () => {
    const writes = bindWrites({ tools: { invoke: async () => ({ status: "saved" }) } });
    expect(await writes!.invoke("meals.list.edit", {})).toEqual({ kind: "saved" });
  });

  it("gives each outcome its own message and none for success or cancel", () => {
    const messages = [
      noticeFor({ kind: "rejected" }),
      noticeFor({ kind: "invalid_input" }),
      noticeFor({ kind: "saved" }),
      noticeFor({ kind: "failed" })
    ];
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) expect(m).toBeTruthy();
    expect(noticeFor({ kind: "succeeded" })).toBeNull();
    expect(noticeFor({ kind: "cancelled" })).toBeNull();
  });
});

describe("outcome messages on a page", () => {
  it.each([
    ["rejected", { status: "rejected" }],
    ["invalid_input", { status: "invalid_input" }],
    ["saved", { status: "saved" }],
    ["failed", { status: "failed" }]
  ] as const)("the shopping list shows its own message for %s", async (kind, outcome) => {
    const invoke = vi.fn(async () => outcome);
    const renderer = await render("/m/meals/list", { tools: { invoke } });
    await act(async () => {
      renderer.root
        .find((n) => n.type === "input" && n.props["aria-label"] === "Got carrot")
        .props.onChange({ target: { checked: true } });
    });
    expect(text(renderer)).toContain(noticeFor({ kind } as never)!);
    expect(text(renderer)).not.toContain("That did not go through");
  });

  it("shows nothing when the person cancels", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const renderer = await render("/m/meals/list", { tools: { invoke } });
    await act(async () => {
      renderer.root
        .find((n) => n.type === "input" && n.props["aria-label"] === "Got carrot")
        .props.onChange({ target: { checked: true } });
    });
    expect(renderer.root.findAll((n) => n.props.role === "alert")).toEqual([]);
  });
});

describe("destructive controls", () => {
  it("Clear list calls meals.list.clear", async () => {
    const invoke = vi.fn(async () => ({ status: "succeeded", result: { cleared: true } }));
    const renderer = await render("/m/meals/list", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Clear list")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.list.clear", { listId: "list1" });
  });

  it("Delete plan calls meals.plan.delete", async () => {
    const invoke = vi.fn(async () => ({ status: "succeeded", result: { deleted: true } }));
    const renderer = await render("/m/meals", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Delete plan")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.plan.delete", { planId: "p1" });
  });

  it("offers neither without a tools handle", async () => {
    const list = await render("/m/meals/list");
    expect(buttons(list, "Clear list")).toEqual([]);
    const plan = await render("/m/meals");
    expect(buttons(plan, "Delete plan")).toEqual([]);
  });
});

describe("household controls", () => {
  const kitchen = {
    kitchenId: "k",
    unitsSystem: "metric",
    defaultPantryMode: "prefer",
    members: [
      {
        memberId: "m1",
        name: "You",
        isSelf: true,
        linkedAccountEmail: null,
        calorieTarget: null,
        macroTargets: { proteinG: null, carbG: null, fatG: null },
        mealPattern: ["breakfast", "lunch", "dinner"],
        restrictions: [],
        preferences: [],
        favouriteRecipeIds: []
      }
    ],
    slotRules: []
  };

  it("Add person saves a new member through the handle and reloads", async () => {
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.kitchen.get") return kitchen;
      return { plan: null };
    });
    const invoke = vi.fn(async () => ({ status: "succeeded", result: {} }));
    const renderer = await render("/m/meals/household", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Add person")[0]!.props.onClick();
    });
    const field = (label: string) =>
      renderer.root.find((n) => n.type === "input" && n.props["aria-label"] === label);
    await act(async () => {
      field("Name").props.onChange({ target: { value: "Sam" } });
      field("Never serve").props.onChange({ target: { value: "peanuts, shellfish" } });
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.household.save", {
      name: "Sam",
      restrictions: ["peanuts", "shellfish"]
    });
  });

  it("will not save a person with no name", async () => {
    mockReadTool.mockImplementation(async (name: string) =>
      name === "meals.kitchen.get" ? kitchen : { plan: null }
    );
    const invoke = vi.fn();
    const renderer = await render("/m/meals/household", { tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Add person")[0]!.props.onClick();
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Enter a name first");
  });
});

describe("cancelled destructive actions", () => {
  it("Clear list shows no message and reloads the list when the person cancels", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const renderer = await render("/m/meals/list", { tools: { invoke } });
    const before = mockReadTool.mock.calls.filter(([name]) => name === "meals.list.get").length;
    await act(async () => {
      buttons(renderer, "Clear list")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.list.clear", { listId: "list1" });
    expect(renderer.root.findAll((n) => n.props.role === "alert")).toEqual([]);
    expect(mockReadTool.mock.calls.filter(([name]) => name === "meals.list.get").length).toBe(
      before + 1
    );
    expect(buttons(renderer, "Clear list").length).toBeGreaterThan(0);
  });

  it("Delete plan shows no message and reloads the plan when the person cancels", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const renderer = await render("/m/meals", { tools: { invoke } });
    const before = mockReadTool.mock.calls.filter(([name]) => name === "meals.plan.current").length;
    await act(async () => {
      buttons(renderer, "Delete plan")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.plan.delete", { planId: "p1" });
    expect(renderer.root.findAll((n) => n.props.role === "alert")).toEqual([]);
    expect(mockReadTool.mock.calls.filter(([name]) => name === "meals.plan.current").length).toBe(
      before + 1
    );
    expect(buttons(renderer, "Delete plan").length).toBeGreaterThan(0);
  });
});

describe("outcome messages on the other screens", () => {
  const OUTCOMES = ["rejected", "invalid_input", "saved", "failed"] as const;
  const failingWith = (status: string) => vi.fn(async () => ({ status }));
  const shown = (renderer: ReactTestRenderer, kind: (typeof OUTCOMES)[number]) => {
    expect(text(renderer)).toContain(noticeFor({ kind } as never)!);
    expect(text(renderer)).not.toContain("That did not go through");
  };
  const two = {
    kitchenId: "k",
    unitsSystem: "metric",
    defaultPantryMode: "prefer",
    members: [
      {
        memberId: "m1",
        name: "You",
        isSelf: true,
        linkedAccountEmail: null,
        calorieTarget: null,
        macroTargets: { proteinG: null, carbG: null, fatG: null },
        mealPattern: ["dinner"],
        restrictions: [],
        preferences: [],
        favouriteRecipeIds: []
      },
      {
        memberId: "m2",
        name: "Sam",
        isSelf: false,
        linkedAccountEmail: null,
        calorieTarget: null,
        macroTargets: { proteinG: null, carbG: null, fatG: null },
        mealPattern: ["dinner"],
        restrictions: [],
        preferences: [],
        favouriteRecipeIds: []
      }
    ],
    slotRules: []
  };
  beforeEach(() => {
    mockReadTool.mockImplementation(async (name: string) =>
      name === "meals.kitchen.get" ? two : { plan: null }
    );
  });

  it.each(OUTCOMES)("Delete plan shows its own message for %s", async (kind) => {
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.kitchen.get") return two;
      if (name === "meals.plan.current") return { plan: PLAN };
      throw new Error(`unexpected tool ${name}`);
    });
    const renderer = await render("/m/meals", { tools: { invoke: failingWith(kind) } });
    await act(async () => {
      buttons(renderer, "Delete plan")[0]!.props.onClick();
    });
    shown(renderer, kind);
  });

  it.each(OUTCOMES)("Remove person shows its own message for %s", async (kind) => {
    const renderer = await render("/m/meals/household", { tools: { invoke: failingWith(kind) } });
    await act(async () => {
      buttons(renderer, "Remove Sam")[0]!.props.onClick();
    });
    shown(renderer, kind);
  });

  it.each(OUTCOMES)("Add person shows its own message for %s", async (kind) => {
    const renderer = await render("/m/meals/household", { tools: { invoke: failingWith(kind) } });
    await act(async () => {
      buttons(renderer, "Add person")[0]!.props.onClick();
    });
    await act(async () => {
      renderer.root
        .find((n) => n.type === "input" && n.props["aria-label"] === "Name")
        .props.onChange({ target: { value: "Pat" } });
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    shown(renderer, kind);
  });

  it.each(OUTCOMES)("Settings shows its own message for %s", async (kind) => {
    const renderer = await render("/m/meals/settings", { tools: { invoke: failingWith(kind) } });
    await act(async () => {
      renderer.root.find((n) => n.props.ariaLabel === "Units").props.onChange("us");
    });
    shown(renderer, kind);
  });

  it.each(OUTCOMES)("Start a plan shows its own message for %s", async (kind) => {
    const renderer = await render("/m/meals/plan/new", { tools: { invoke: failingWith(kind) } });
    await act(async () => {
      buttons(renderer, "Start the plan")[0]!.props.onClick();
    });
    shown(renderer, kind);
  });
});
