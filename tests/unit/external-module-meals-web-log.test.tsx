// @vitest-environment jsdom
//
// Meals S6 (#3890): the Log area renders through the real Root. Only ./api is mocked.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadTool } = vi.hoisted(() => ({ mockReadTool: vi.fn() }));
vi.mock("../../external-modules/meals/src/web/api", () => ({ readTool: mockReadTool }));

import type {
  LogEntryView,
  LogListResult,
  NutrientsView
} from "../../external-modules/meals/src/contracts";
import { Root } from "../../external-modules/meals/src/web/root";

const nutrients = (caloriesKcal: number | null, proteinG: number | null): NutrientsView => ({
  caloriesKcal,
  proteinG,
  carbohydratesG: null,
  fatG: null,
  fiberG: null,
  sugarG: null,
  sodiumMg: null
});

const entry = (overrides: Partial<LogEntryView> = {}): LogEntryView => ({
  entryId: "e1",
  consumedAt: "2026-11-02T08:30:00.000Z",
  localDate: "2026-11-02",
  timezoneOffset: 0,
  description: "Two eggs on toast",
  servingNote: null,
  captureKind: "text",
  estimateState: "estimated",
  estimateRevision: 2,
  nutrients: nutrients(320, 18),
  items: [{ label: "Eggs", portionNote: "2", nutrients: nutrients(180, 12) }],
  missingDetails: null,
  clarificationQuestion: null,
  ...overrides
});

const day = (overrides: Partial<LogListResult> = {}): LogListResult => ({
  entries: [
    entry(),
    entry({
      entryId: "e2",
      description: "Chicken salad",
      consumedAt: "2026-11-02T12:30:00.000Z",
      nutrients: nutrients(450, 35),
      items: []
    })
  ],
  totals: {
    localDate: "2026-11-02",
    nutrients: nutrients(770, 53),
    incomplete: false,
    entriesWithoutEstimate: 0
  },
  targets: { caloriesKcal: 2000, proteinG: 120, carbG: null, fatG: null },
  calorieFit: { targetKcal: 2000, estimatedKcal: 770, band: "under", differenceKcal: -1230 },
  truncated: false,
  totalCount: 2,
  ...overrides
});

let current: LogListResult;

beforeEach(() => {
  mockReadTool.mockReset();
  current = day();
  mockReadTool.mockImplementation(async (name: string) => {
    if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
    if (name === "meals.plan.current") return { plan: null };
    if (name === "meals.log.list") return current;
    throw new Error(`unexpected tool ${name}`);
  });
});

async function render(props: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", "/m/meals/log");
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

describe("Log without a tools handle", () => {
  it("shows totals against targets, meals by part of the day, and times", async () => {
    const shown = text(await render());
    expect(shown).toContain("770");
    expect(shown).toContain("of 2000 kcal");
    expect(shown).toContain("1230 kcal under");
    expect(shown).toContain("of 120 g");
    expect(shown).toContain("Breakfast");
    expect(shown).toContain("Lunch");
    expect(shown).toContain("Two eggs on toast");
    expect(shown).toContain("8:30 AM");
    expect(shown).toContain("12:30 PM");
  });

  it("offers Ask Moss and no write control", async () => {
    const renderer = await render();
    expect(buttons(renderer, "Ask Moss").length).toBeGreaterThan(0);
    for (const label of ["Log a meal", "Edit Two eggs on toast", "Delete Two eggs on toast"]) {
      expect(buttons(renderer, label)).toEqual([]);
    }
  });

  it("shows the empty state", async () => {
    current = day({ entries: [], totals: null, calorieFit: null, totalCount: 0 });
    expect(text(await render())).toContain("Nothing logged");
  });

  it("shows unknown figures as a dash, never zero, and counts uncounted meals", async () => {
    current = day({
      entries: [
        entry({ estimateState: "pending", nutrients: null, items: [], estimateRevision: 1 })
      ],
      totals: {
        localDate: "2026-11-02",
        nutrients: nutrients(null, null),
        incomplete: true,
        entriesWithoutEstimate: 1
      },
      calorieFit: null
    });
    const shown = text(await render());
    expect(shown).toContain("Estimating");
    expect(shown).toContain("1 meal is not counted yet.");
    expect(shown).not.toMatch(/\b0 kcal/);
  });

  it("shows the error state with Try again", async () => {
    mockReadTool.mockImplementation(async (name: string) => {
      if (name === "meals.log.list") throw new Error("boom");
      if (name === "meals.kitchen.get") return { kitchenId: "k", members: [], slotRules: [] };
      return { plan: null };
    });
    const renderer = await render();
    expect(text(renderer)).toContain("Couldn't load the Log");
    expect(buttons(renderer, "Try again")).toHaveLength(1);
  });

  it("expands a meal to its foods", async () => {
    const renderer = await render();
    await act(async () => {
      buttons(renderer, "Show foods")[0]!.props.onClick();
    });
    expect(text(renderer)).toContain("Eggs, 2");
    expect(text(renderer)).toContain("180 kcal");
  });
});

describe("Log with a tools handle", () => {
  it("logs a meal with the browser time zone and a fresh key", async () => {
    const invoke = vi.fn(async () => ({ status: "succeeded", result: {} }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Log a meal")[0]!.props.onClick();
    });
    const field = renderer.root.find(
      (node) => node.type === "input" && node.props.placeholder === "Two eggs on toast"
    );
    await act(async () => {
      field.props.onChange({ target: { value: "Oatmeal" } });
    });
    await act(async () => {
      buttons(renderer, "Log").at(-1)!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, input] = invoke.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe("meals.log.add");
    expect(input).toMatchObject({ description: "Oatmeal", captureKind: "text" });
    expect(String(input.idempotencyKey)).toMatch(/^log-/);
    expect(String(input.consumedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  });

  it("corrects only the figure that changed, at the revision it read", async () => {
    const invoke = vi.fn(async () => ({ status: "succeeded", result: {} }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Edit Two eggs on toast")[0]!.props.onClick();
    });
    const calories = renderer.root.find(
      (node) => node.type === "input" && node.props.value === "180"
    );
    await act(async () => {
      calories.props.onChange({ target: { value: "200" } });
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.log.correct", {
      entryId: "e1",
      expectedRevision: 2,
      items: [{ nutrients: { caloriesKcal: 200 } }]
    });
  });

  it("refuses a figure that is not a number", async () => {
    const invoke = vi.fn();
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Edit Two eggs on toast")[0]!.props.onClick();
    });
    const calories = renderer.root.find(
      (node) => node.type === "input" && node.props.value === "180"
    );
    await act(async () => {
      calories.props.onChange({ target: { value: "lots" } });
    });
    await act(async () => {
      buttons(renderer, "Save")[0]!.props.onClick();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("must be a number");
  });

  it("deletes through the host, and a cancelled confirm shows no error", async () => {
    const invoke = vi.fn(async () => ({ status: "cancelled" }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Delete Two eggs on toast")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.log.delete", { entryId: "e1" });
    expect(text(renderer)).not.toContain("did not go through");
  });

  it("retries a failed estimate", async () => {
    current = day({ entries: [entry({ estimateState: "failed", nutrients: null, items: [] })] });
    const invoke = vi.fn(async () => ({ status: "succeeded", result: {} }));
    const renderer = await render({ tools: { invoke } });
    await act(async () => {
      buttons(renderer, "Retry Two eggs on toast")[0]!.props.onClick();
    });
    expect(invoke).toHaveBeenCalledWith("meals.log.reestimate", { entryId: "e1" });
  });
});
