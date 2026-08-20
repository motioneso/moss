// @vitest-environment jsdom
//
// Food phase 2 (#1737, spec 2026-08-19 §Testing Decisions): the day view itself.
//
// jsdom rather than the plain node environment job-search-web-root.test.tsx uses: this Root
// subscribes to `document`'s visibilitychange (the fix for the no-refresh defect), so a fake
// document would leave the whole refresh path untested — which is the part most likely to break.
//
// Only ./api is mocked. The domain functions the view depends on (occasion bucketing, net carbs)
// run for real, so a test asserting "net carbs are blank" is asserting against the real rule
// rather than against a stub of it.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvokeTool } = vi.hoisted(() => ({ mockInvokeTool: vi.fn() }));
vi.mock("../../external-modules/food/src/web/api", () => ({ invokeTool: mockInvokeTool }));

import { Root, groupByOccasion } from "../../external-modules/food/src/web/root";
import type { Meal, MealItem, Nutrients } from "../../external-modules/food/src/domain/meal";

// ── fixtures ────────────────────────────────────────────────────────────

const NO_NUTRIENTS: Nutrients = {
  caloriesKcal: null,
  proteinG: null,
  carbohydratesG: null,
  fatG: null,
  fiberG: null,
  sugarG: null,
  sodiumMg: null
};

function nutrients(partial: Partial<Nutrients>): Nutrients {
  return { ...NO_NUTRIENTS, ...partial };
}

function item(
  label: string,
  partial: Partial<Nutrients>,
  portionNote: string | null = null
): MealItem {
  return { label, portionNote, nutrients: nutrients(partial) };
}

/** All fixtures use offset 0 so the hour in `consumedAt` is the hour the view must show. */
function meal(overrides: Partial<Meal> & Pick<Meal, "mealId" | "consumedAt">): Meal {
  return {
    localDate: "2026-08-19",
    timezoneOffset: 0,
    description: "A meal",
    servingNote: null,
    captureKind: "text",
    estimateState: "estimated",
    estimateRevision: 1,
    nutrients: NO_NUTRIENTS,
    items: [],
    missingDetails: null,
    ...overrides
  };
}

// ── harness ─────────────────────────────────────────────────────────────

interface ListPayload {
  meals: Meal[];
  totals: {
    localDate: string;
    nutrients: Nutrients;
    incomplete: boolean;
    mealsWithoutEstimate: number;
  } | null;
  aiEstimates?: boolean;
  targets?: {
    caloriesKcal: number | null;
    proteinG: number | null;
    netCarbsG: number | null;
    fatG: number | null;
  };
}

let listPayload: ListPayload = { meals: [], totals: null, aiEstimates: true };
let listCalls = 0;

beforeEach(() => {
  listCalls = 0;
  listPayload = { meals: [], totals: null, aiEstimates: true };
  mockInvokeTool.mockReset();
  mockInvokeTool.mockImplementation(async (name: string) => {
    if (name === "food.meals.list") {
      listCalls += 1;
      return { kind: "ok", result: listPayload };
    }
    return { kind: "error", message: `unexpected tool ${name}` };
  });
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Root));
  });
  // Several flushes: the meals query settles across more than one microtask tick.
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

function text(renderer: ReactTestRenderer): string {
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

/** Every className on every rendered node, joined — for asserting which rail a row carries. */
function classNames(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(() => true, { deep: true })
    .map((node) => (typeof node.props?.className === "string" ? node.props.className : ""))
    .join(" ");
}

// ── tests ───────────────────────────────────────────────────────────────

describe("food day view — headline figures (#1737)", () => {
  it("renders an unestimated nutrient as an em dash, never as 0", async () => {
    listPayload = {
      meals: [meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" })],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 1840, proteinG: 96, carbohydratesG: 210 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    const out = text(await render());
    expect(out).toContain("1,840");
    expect(out).toContain("96.0 g");
    // Fat, fiber, sugar and sodium were never estimated. A "0 g fat" here would be the
    // never-coalesce rule leaking away at the last step, after the store and domain both
    // preserved the null.
    // Leading whitespace, not \b: "96.0 g" contains a word boundary before its 0.
    expect(out).not.toMatch(/\s0(\.0)? (g|mg)\b/);
    expect(out).toContain("—");
  });

  it("shows net carbs as carbohydrates less fiber, and blank when fiber was not estimated", async () => {
    listPayload = {
      meals: [meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" })],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 500, carbohydratesG: 60, fiberG: 8 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    expect(text(await render())).toContain("52.0 g");

    listPayload = {
      ...listPayload,
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 500, carbohydratesG: 60 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    // Fails against `carbs - (fiber ?? 0)`, which would report the full 60 g as net — the
    // largest possible answer, presented as a precise one.
    expect(text(await render())).not.toContain("60.0 g");
  });

  it("renders no progress indicator when no targets are set, and still shows the totals", async () => {
    listPayload = {
      meals: [meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" })],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 1840, proteinG: 96 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    const renderer = await render();
    // With no target there is nothing to measure against, and the usual shape of this bug is a
    // 0%, a NaN, or an empty bar where the user asked for nothing at all.
    expect(renderer.root.findAllByType("progress")).toHaveLength(0);
    const out = text(renderer);
    expect(out).not.toContain("%");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain(" of ");
    expect(out).not.toContain("left");
    expect(out).toContain("1,840");
  });

  it("shows how much of a target is left, and says over once past it (#1757)", async () => {
    listPayload = {
      meals: [meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" })],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 1840, proteinG: 96 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      },
      targets: { caloriesKcal: 2200, proteinG: 80, netCarbsG: null, fatG: null }
    };
    const out = text(await render());
    expect(out).toContain("of 2,200 kcal");
    expect(out).toContain("360 kcal left");
    // Past a target the remaining figure must not read as a negative amount left — "16 g over"
    // is the sentence a person would say, and "-16 left" is the bug this catches.
    expect(out).toContain("16 g over");
    expect(out).not.toContain("-16");
  });

  it("leaves a target off entirely when only some are set (#1757)", async () => {
    listPayload = {
      meals: [meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" })],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 1840, proteinG: 96 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      },
      targets: { caloriesKcal: 2200, proteinG: null, netCarbsG: null, fatG: null }
    };
    const out = text(await render());
    expect(out).toContain("of 2,200 kcal");
    // Every unset target must stay silent rather than borrowing the calorie one.
    expect(out.match(/ of /g) ?? []).toHaveLength(1);
  });

  it("discloses that a meal without a finished estimate is not counted", async () => {
    listPayload = {
      meals: [
        meal({ mealId: "m1", consumedAt: "2026-08-19T12:30:00.000Z" }),
        meal({
          mealId: "m2",
          consumedAt: "2026-08-19T13:00:00.000Z",
          estimateState: "pending",
          nutrients: null
        })
      ],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 400 }),
        incomplete: true,
        mealsWithoutEstimate: 1
      }
    };
    expect(text(await render())).toContain("1 meal today has no finished estimate");
  });
});

describe("food day view — meals and their foods (#1737)", () => {
  it("expands a meal into one row per food", async () => {
    listPayload = {
      meals: [
        meal({
          mealId: "m1",
          consumedAt: "2026-08-19T12:30:00.000Z",
          description: "6 hot wings and 2 breadsticks",
          nutrients: nutrients({ caloriesKcal: 940 }),
          items: [
            item("Hot wings", { caloriesKcal: 660, proteinG: 54 }, "6"),
            item("Breadsticks", { caloriesKcal: 280, proteinG: 8 }, "2")
          ]
        })
      ],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 940 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    const renderer = await render();
    // Collapsed: the foods are not on screen yet.
    expect(text(renderer)).not.toContain("Breadsticks");
    expect(text(renderer)).toContain("2 foods");

    const row = renderer.root
      .findAllByType("button")
      .find((b) => b.props["aria-expanded"] === false);
    expect(row).toBeDefined();
    await act(async () => {
      row!.props.onClick();
    });

    const out = text(renderer);
    expect(out).toContain("Hot wings");
    expect(out).toContain("660 kcal");
    expect(out).toContain("Breadsticks");
    expect(out).toContain("280 kcal");
  });

  it("gives a meal with no breakdown no expander at all", async () => {
    listPayload = {
      meals: [
        meal({
          mealId: "m1",
          consumedAt: "2026-08-19T12:30:00.000Z",
          estimateState: "pending",
          nutrients: null
        })
      ],
      totals: {
        localDate: "2026-08-19",
        nutrients: NO_NUTRIENTS,
        incomplete: true,
        mealsWithoutEstimate: 1
      }
    };
    const renderer = await render();
    // An expander that opens onto nothing is worse than no expander: it reads as data the page
    // is refusing to show.
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    expect(text(renderer)).toContain("Estimating…");
  });

  it("groups meals under occasion headers in day order, not arrival order", async () => {
    listPayload = {
      meals: [
        meal({ mealId: "dinner", consumedAt: "2026-08-19T19:00:00.000Z", description: "Chili" }),
        meal({
          mealId: "breakfast",
          consumedAt: "2026-08-19T08:00:00.000Z",
          description: "Oatmeal"
        })
      ],
      totals: {
        localDate: "2026-08-19",
        nutrients: nutrients({ caloriesKcal: 900 }),
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    const out = text(await render());
    // Fails if the view renders the store's order (newest first) under occasion labels, which
    // would print Dinner above Breakfast.
    expect(out.indexOf("Breakfast")).toBeGreaterThan(-1);
    expect(out.indexOf("Breakfast")).toBeLessThan(out.indexOf("Dinner"));
    expect(out.indexOf("Oatmeal")).toBeLessThan(out.indexOf("Chili"));
  });

  it("carries the estimate state on the row's rail, not as a coloured pill or border", async () => {
    listPayload = {
      meals: [
        meal({
          mealId: "m1",
          consumedAt: "2026-08-19T12:30:00.000Z",
          estimateState: "needs_details",
          nutrients: null
        })
      ],
      totals: {
        localDate: "2026-08-19",
        nutrients: NO_NUTRIENTS,
        incomplete: true,
        mealsWithoutEstimate: 1
      }
    };
    const classes = classNames(await render());
    expect(classes).toContain("jds-rail--gold");
    // The occasion accent belongs to the section head above; a row carrying both would be two
    // signals fighting over the same three pixels.
    expect(classes).toContain("jds-rail--afternoon");
  });
});

describe("food day view — staying current (#1737)", () => {
  it("re-reads the day when the tab becomes visible again", async () => {
    listPayload = {
      meals: [],
      totals: {
        localDate: "2026-08-19",
        nutrients: NO_NUTRIENTS,
        incomplete: false,
        mealsWithoutEstimate: 0
      }
    };
    await render();
    const afterMount = listCalls;
    expect(afterMount).toBeGreaterThan(0);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    // Phase 1 fetched once per mount and never again, so a meal logged in Chat did not reach
    // this page until a manual reload. Fails against that implementation.
    expect(listCalls).toBeGreaterThan(afterMount);
  });
});

describe("groupByOccasion (#1737)", () => {
  it("drops occasions nothing landed in", async () => {
    const groups = groupByOccasion([
      meal({ mealId: "a", consumedAt: "2026-08-19T08:00:00.000Z" }),
      meal({ mealId: "b", consumedAt: "2026-08-19T23:30:00.000Z" })
    ]);
    // An empty "Dinner" header above nothing reads as a missing meal rather than as a day that
    // is not over yet.
    expect(groups.map((group) => group.occasion)).toEqual(["breakfast", "snack"]);
  });
});

describe("AI-estimates note (#1750)", () => {
  it("says nothing when estimates are on — a permanent 'on' badge is a nag, not information", async () => {
    listPayload = { meals: [], totals: null, aiEstimates: true };
    const text = flatten((await render()).toJSON());
    expect(text).not.toContain("Nutrition estimates are off");
  });

  it("explains the missing numbers when estimates are off, and names where to turn them on", async () => {
    listPayload = { meals: [], totals: null, aiEstimates: false };
    const text = flatten((await render()).toJSON());
    // Without this the page shows meals with permanently blank nutrition and no reason why,
    // which reads as the estimator being broken rather than as a setting the user chose.
    expect(text).toContain("Nutrition estimates are off");
    expect(text).toContain("Settings");
  });

  it("stays silent when the flag is absent, rather than claiming estimates are off", async () => {
    // An older installed module build returns a list result without the field. Treating that
    // as "off" would tell every such user their estimates are disabled when they are not.
    listPayload = { meals: [], totals: null };
    const text = flatten((await render()).toJSON());
    expect(text).not.toContain("Nutrition estimates are off");
  });
});

describe("a meal with no estimate coming (#1770)", () => {
  const pendingMeal = meal({
    mealId: "m-pending",
    consumedAt: "2026-08-19T08:00:00.000Z",
    description: "Two eggs on toast",
    estimateState: "pending",
    estimateRevision: 0
  });

  it("says the meal was not estimated when estimates are off", async () => {
    // A meal logged with the switch off is `pending` by construction and nothing is queued for
    // it, so "Estimating…" would be a permanent claim about work that never started.
    listPayload = { meals: [pendingMeal], totals: null, aiEstimates: false };
    expect(text(await render())).toContain("Not estimated");
  });

  it("still says Estimating when an estimate really is on its way", async () => {
    listPayload = { meals: [pendingMeal], totals: null, aiEstimates: true };
    expect(text(await render())).toContain("Estimating");
  });

  it("says Estimating when the flag is absent, rather than assuming nothing is running", async () => {
    // Same reason as the note above: an older installed build omits the field, and reading that
    // as "off" would tell the user their in-flight estimate was never started.
    listPayload = { meals: [pendingMeal], totals: null };
    expect(text(await render())).toContain("Estimating");
  });
});
