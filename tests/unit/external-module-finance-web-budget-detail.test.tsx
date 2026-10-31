// @vitest-environment jsdom
//
// The Budget screen in a real DOM: Enter and Shift+Enter between Assigned fields, and the
// category detail panel with quick amounts and Move money. Server data comes through a faked
// fetch at the network edge; the screen, router and store run for real.
import "./helpers/install-module-runtime";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { quickAmounts } from "../../external-modules/finance/src/web/category-detail";
import { BudgetScreen } from "../../external-modules/finance/src/web/screens/budget";
import { currentLiveMessage } from "../../external-modules/finance/src/web/states";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const category = (id: string, name: string, tableGroup: string) => ({
  id,
  name,
  group: "x",
  archived: false,
  tableGroup
});

// Groceries per month: assigned, spent. October is the month on screen.
const groceries: Record<string, [number, number]> = {
  "2026-10": [65_000, 41_827],
  "2026-09": [60_000, 52_000],
  "2026-08": [60_000, 47_000],
  "2026-07": [60_000, 45_500]
};

let currencyCode = "USD";

function status(month: string) {
  const [assigned, spent] = groceries[month] ?? [0, 0];
  return {
    month,
    currentMonth: "2026-10",
    revision: 7,
    fingerprint: "a".repeat(32),
    isoCurrency: currencyCode,
    hasBank: true,
    hasBudget: true,
    readyToAssignCents: 123_456,
    accounts: [],
    categories: [
      category("groceries", "Groceries", "Everyday"),
      category("dining", "Dining & coffee", "Everyday"),
      category("savings", "Savings", "Savings")
    ],
    targets:
      month === "2026-10"
        ? [
            {
              categoryId: "groceries",
              effectiveMonth: "2026-10",
              kind: "monthly",
              amountCents: 70_000,
              dueDate: null,
              progressCents: 65_000,
              remainingCents: 5_000,
              suggestedCents: 5_000,
              status: "in-progress"
            }
          ]
        : [],
    state: {
      categories: {
        groceries: {
          assignedCents: assigned,
          activityCents: spent,
          availableCents: assigned - spent
        },
        dining: { assignedCents: 22_000, activityCents: 24_650, availableCents: -2_650 },
        savings: { assignedCents: 30_000, activityCents: 0, availableCents: 900_000 }
      }
    }
  };
}

function fakeFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const month = (JSON.parse(init.body) as { input: { month: string } }).input.month;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ invocation: { status: "succeeded", result: status(month) } })
      };
    })
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(tools: ExternalModuleToolsHandleV1) {
  fakeFetch();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<BudgetScreen tools={tools} />));
  await act(async () => {});
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  __resetStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currencyCode = "USD";
});

const field = (layout: "desktop" | "phone", id: string) =>
  document.querySelector<HTMLInputElement>(
    `input[data-fnm-assign="${layout}"][data-fnm-line="${id}"]`
  )!;

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: Element, key: string, shiftKey = false) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
}

async function click(target: Element) {
  await act(async () => {
    (target as HTMLElement).click();
  });
}

const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label
  )!;

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

const idle = (): ExternalModuleToolsHandleV1 => ({
  invoke: vi.fn(async (): Promise<ModuleToolOutcome> => ({ status: "cancelled" }))
});

describe("Budget keyboard entry", () => {
  it("moves down with Enter and up with Shift+Enter within one layout", async () => {
    await mount(idle());
    field("desktop", "groceries").focus();
    await press(field("desktop", "groceries"), "Enter");
    expect(document.activeElement).toBe(field("desktop", "dining"));
    await press(field("desktop", "dining"), "Enter");
    expect(document.activeElement).toBe(field("desktop", "savings"));
    // The last field stays put rather than jumping into the hidden phone layout.
    await press(field("desktop", "savings"), "Enter");
    expect(document.activeElement).toBe(field("desktop", "savings"));
    await press(field("desktop", "savings"), "Enter", true);
    expect(document.activeElement).toBe(field("desktop", "dining"));
    field("phone", "groceries").focus();
    await press(field("phone", "groceries"), "Enter");
    expect(document.activeElement).toBe(field("phone", "dining"));
  });

  it("saves a changed amount on Enter and moves on", async () => {
    const tools = idle();
    await mount(tools);
    field("desktop", "groceries").focus();
    await typeInto(field("desktop", "groceries"), "700");
    await press(field("desktop", "groceries"), "Enter");
    expect(tools.invoke).toHaveBeenCalledWith(
      "finance.budget.assign",
      expect.objectContaining({ categoryId: "groceries", amountCents: 70_000 })
    );
    expect(document.activeElement).toBe(field("desktop", "dining"));
  });

  it("keeps focus on a field whose amount does not parse", async () => {
    const tools = idle();
    await mount(tools);
    field("desktop", "groceries").focus();
    await typeInto(field("desktop", "groceries"), "lots");
    await press(field("desktop", "groceries"), "Enter");
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("desktop", "groceries"));
  });
});

describe("Category detail panel", () => {
  async function open(name: string) {
    const opener = [...document.querySelectorAll("button.jds-table__rowlink")].find(
      (candidate) => candidate.textContent === name
    )!;
    await click(opener);
    await act(async () => {});
    return opener;
  }

  it("shows the month's figures, the target and quick amounts from earlier months", async () => {
    await mount(idle());
    await open("Groceries");
    const panel = dialog()!;
    expect(panel.textContent).toContain("Groceries");
    expect(panel.textContent).toContain("$700.00 each month, $50.00 to go");
    expect(button("Use $700.00, fund target", panel)).toBeTruthy();
    expect(button("Use $600.00, assigned last month", panel)).toBeTruthy();
    expect(button("Use $520.00, spent last month", panel)).toBeTruthy();
    expect(button("Use $481.67, average spent, 3 months", panel)).toBeTruthy();
  });

  it("fills the Assigned field from a quick amount and returns focus to it", async () => {
    const tools = idle();
    await mount(tools);
    await open("Groceries");
    await click(button("Use $520.00, spent last month", dialog()!));
    expect(dialog()).toBeNull();
    expect(field("desktop", "groceries").value).toBe("520.00");
    expect(document.activeElement).toBe(field("desktop", "groceries"));
    expect(tools.invoke).not.toHaveBeenCalled();
    await press(field("desktop", "groceries"), "Enter");
    expect(tools.invoke).toHaveBeenCalledWith(
      "finance.budget.assign",
      expect.objectContaining({ categoryId: "groceries", amountCents: 52_000 })
    );
  });

  it("closes on Escape and returns focus to the category name", async () => {
    await mount(idle());
    const opener = await open("Groceries");
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("covers an overspent category from Ready to assign", async () => {
    const invoke = vi.fn(
      async (): Promise<ModuleToolOutcome> => ({ status: "succeeded", result: { status: "ok" } })
    );
    await mount({ invoke });
    await open("Dining & coffee");
    const panel = dialog()!;
    expect(panel.querySelector<HTMLInputElement>('input[aria-label="Amount to move"]')!.value).toBe(
      "26.50"
    );
    expect(panel.querySelector<HTMLSelectElement>('select[aria-label="Move from"]')!.value).toBe(
      "ready_to_assign"
    );
    await click(button("Move", panel));
    expect(invoke).toHaveBeenCalledWith("finance.budget.move", {
      month: "2026-10",
      fromCategoryId: "ready_to_assign",
      toCategoryId: "dining",
      amountCents: 2_650,
      expectedRevision: 7,
      expectedFingerprint: "a".repeat(32)
    });
    expect(currentLiveMessage()).toBe("Moved $26.50 to Dining & coffee.");
  });

  it("explains a refused move in plain words", async () => {
    const invoke = vi.fn(
      async (): Promise<ModuleToolOutcome> => ({
        status: "rejected",
        moduleCode: "not_enough_ready"
      })
    );
    await mount({ invoke });
    await open("Dining & coffee");
    await click(button("Move", dialog()!));
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "That is more than Ready to assign holds."
    );
  });

  it("stops a move larger than the source holds before sending it", async () => {
    const tools = idle();
    await mount(tools);
    await open("Groceries");
    const panel = dialog()!;
    await click(button("Move out", panel));
    await typeInto(
      panel.querySelector<HTMLInputElement>('input[aria-label="Amount to move"]')!,
      "300"
    );
    await click(button("Move", panel));
    expect(tools.invoke).not.toHaveBeenCalled();
    expect(panel.querySelector('[role="alert"]')!.textContent).toBe(
      "Groceries has $231.73 available."
    );
  });

  it("waits for typed amounts before moving money", async () => {
    await mount(idle());
    await typeInto(field("desktop", "dining"), "300");
    await open("Groceries");
    const panel = dialog()!;
    expect(button("Move", panel).disabled).toBe(true);
    expect(panel.textContent).toContain("Save or clear typed amounts first.");
  });
});

describe("Amount fields in a German-language browser", () => {
  // A currency no other test formats, so its cached formatter is built under the stub.
  function germanBrowser() {
    const Real = Intl.NumberFormat;
    vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      _locale?: unknown,
      options?: Intl.NumberFormatOptions
    ) {
      return new Real("de-DE", options);
    } as never);
  }

  it("fills a plain number from a quick amount and keeps resting values readable", async () => {
    currencyCode = "CHF";
    germanBrowser();
    const tools = idle();
    await mount(tools);
    // The money format here is "650,00 CHF", which the amount reader cannot take back.
    expect(field("desktop", "groceries").value).toBe("650.00");
    await open("Groceries");
    const quick = [...dialog()!.querySelectorAll("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.endsWith("spent last month")
    )!;
    await click(quick);
    expect(field("desktop", "groceries").value).toBe("520.00");
    await press(field("desktop", "groceries"), "Enter");
    expect(tools.invoke).toHaveBeenCalledWith(
      "finance.budget.assign",
      expect.objectContaining({ categoryId: "groceries", amountCents: 52_000 })
    );
  });

  it("fills the Move amount with a plain number", async () => {
    currencyCode = "CHF";
    germanBrowser();
    await mount(idle());
    await open("Dining & coffee");
    expect(
      dialog()!.querySelector<HTMLInputElement>('input[aria-label="Amount to move"]')!.value
    ).toBe("26.50");
  });

  async function open(name: string) {
    const opener = [...document.querySelectorAll("button.jds-table__rowlink")].find(
      (candidate) => candidate.textContent === name
    )!;
    await click(opener);
    await act(async () => {});
  }
});

describe("Overspent tile", () => {
  it("scrolls to the overspent row that is on screen and focuses its name", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    try {
      await mount(idle());
      // Phone width: only the phone layout takes up space.
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.closest(".fnm-phone-only") ? [{}] : []) as unknown as DOMRectList;
      });
      const tile = document.querySelector<HTMLElement>(
        ".fnm-phone-only button.jds-stat-tile--warn"
      )!;
      await click(tile);
      const row = document.querySelector<HTMLElement>(".fnm-phone-only [data-overspent='true']")!;
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(row);
      expect(document.activeElement).toBe(row.querySelector("button.jds-table__rowlink"));
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("quickAmounts", () => {
  const line = {
    currency: "USD",
    id: "groceries",
    name: "Groceries",
    assigned: 60_000,
    spent: 0,
    available: 0,
    carried: 0,
    archived: false
  };

  it("leaves out zero and the amount already assigned", () => {
    const labels = quickAmounts(line, undefined, [{ assigned: 60_000, spent: 0 }, null, null]).map(
      (amount) => amount.label
    );
    expect(labels).toEqual([]);
  });

  it("averages only when all three earlier months read", () => {
    const months = [{ assigned: 1, spent: 300 }, { assigned: 1, spent: 300 }, null];
    expect(quickAmounts(line, undefined, months).map((amount) => amount.label)).toEqual([
      "Assigned last month",
      "Spent last month"
    ]);
  });
});
