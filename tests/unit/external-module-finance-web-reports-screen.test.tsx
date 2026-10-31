// @vitest-environment jsdom
//
// The Reports screen in a real DOM: the cash flow chart, its Monthly numbers table and the net
// worth line. Server data comes through a faked fetch at the network edge, in each read tool's
// own response shape; the screen, store, merge and charts run for real.
import "./helpers/install-module-runtime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReportsScreen } from "../../external-modules/finance/src/web/screens/reports";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const periods = ["2026-08", "2026-09", "2026-10"];
const month = (id: string, incomeCents: number, outflowCents: number) => ({
  month: id,
  byCategory: {},
  byPayee: {},
  cashFlow: { incomeCents, outflowCents, netCents: incomeCents - outflowCents }
});
const currency = { currencies: ["USD"], currency: "USD", currencySelectionRequired: false };

const results: Record<string, unknown> = {
  "finance.reports.spending": {
    ...currency,
    window: periods,
    own: [
      month("2026-08", 100_000, 50_000),
      month("2026-09", 200_000, 150_000),
      month("2026-10", 0, 30_000)
    ],
    shared: [],
    categories: []
  },
  "finance.reports.net-worth": {
    ...currency,
    window: periods,
    points: [
      { date: "2026-08-01", totalCents: 100_000 },
      { date: "2026-08-11", totalCents: 105_000 },
      { date: "2026-10-31", totalCents: 110_000 }
    ],
    headlineCents: 110_000,
    asOf: "2026-10-31"
  }
};

// One reply per household list read, in order; the last one repeats.
type DirectoryReply = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
const emptyDirectory: DirectoryReply = async () => ({
  ok: true,
  json: async () => ({ users: [] })
});
let directoryReplies: DirectoryReply[] = [emptyDirectory];
let directoryReads = 0;

function fakeFetch() {
  directoryReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/users/directory") {
        const reply = directoryReplies[Math.min(directoryReads, directoryReplies.length - 1)]!;
        directoryReads += 1;
        return reply();
      }
      const tool = decodeURIComponent(/assistant-tools\/([^/]+)\/invoke/.exec(url)?.[1] ?? "");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ invocation: { status: "succeeded", result: results[tool] } })
      };
    })
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount() {
  fakeFetch();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ReportsScreen />));
  await act(async () => {});
  await act(async () => {});
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  __resetStoreForTests();
  vi.unstubAllGlobals();
  directoryReplies = [emptyDirectory];
});

const region = (name: string) =>
  document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
const plot = (scope: HTMLElement) => scope.querySelector<HTMLElement>(".jds-chart__plot")!;
const spoken = (scope: HTMLElement) => scope.querySelector(".jds-sr-only")?.textContent ?? "";
const toggle = () =>
  [...region("Cash flow").querySelectorAll("button")].find(
    (button) => button.textContent === "Monthly numbers"
  )!;

describe("Reports screen charts", () => {
  it("charts cash flow by month with period totals and keeps the table behind a disclosure", async () => {
    await mount();
    const cash = region("Cash flow");
    expect(plot(cash).getAttribute("aria-label")).toBe("Cash flow by month");
    const legend = [...cash.querySelectorAll(".jds-chart__legend-item")].map(
      (item) => item.textContent
    );
    expect(legend).toEqual(["Income$3,000.00", "Outflow$2,300.00", "Net$700.00"]);
    expect(cash.textContent).not.toContain("Includes pending transactions");

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(cash.querySelector("table")).toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const income = cash.querySelector('button[aria-label="View income for October 2026"]');
    expect(income).not.toBeNull();
    expect(cash.querySelector("table")?.textContent).toContain("-$300.00");
  });

  it("reads one month aloud on focus and steps with the arrow keys", async () => {
    await mount();
    const cash = region("Cash flow");
    await act(async () => plot(cash).focus());
    expect(spoken(cash)).toBe("October 2026, Income $0.00, Outflow $300.00, Net -$300.00");
    await act(async () => {
      plot(cash).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(spoken(cash)).toBe("September 2026, Income $2,000.00, Outflow $1,500.00, Net $500.00");
  });

  it("draws net worth as a dated line with a readout and no sources caption", async () => {
    await mount();
    const worth = region("Net worth");
    expect(worth.textContent).not.toContain("Manual balances follow");
    expect(worth.textContent).toContain("As of Oct 31, 2026");
    expect(worth.querySelector(".jds-chart__x--ends")?.textContent).toBe("Aug 1, 2026Oct 31, 2026");
    const line = worth.querySelector(".jds-chart__line")!.getAttribute("d")!;
    expect(line.startsWith("M0.000,")).toBe(true);
    expect(line).toContain("L100.000,");
    await act(async () => plot(worth).focus());
    expect(spoken(worth)).toBe("October 31, 2026, Net worth $1,100.00");
  });

  it("marks category rows past the top five to fold on phones behind Show all", async () => {
    const original = results["finance.reports.spending"];
    const byCategory = Object.fromEntries(
      ["Rent", "Food", "Fuel", "Gifts", "Books", "Games", "Music"].map((name, index) => [
        name,
        7_000 - index * 1_000
      ])
    );
    results["finance.reports.spending"] = {
      ...currency,
      window: periods,
      own: [
        month("2026-08", 0, 0),
        month("2026-09", 0, 0),
        { ...month("2026-10", 0, 28_000), byCategory }
      ],
      shared: [],
      categories: []
    };
    try {
      await mount();
      const list = region("Spending by category");
      const rows = [...list.querySelectorAll(".fnm-report-bar-row")];
      expect(rows.map((row) => row.classList.contains("fnm-report-bar-row--fold"))).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        true
      ]);
      const more = list.querySelector<HTMLButtonElement>(
        'button[aria-controls="fnm-report-categories"]'
      )!;
      expect(more.textContent).toBe("Show all 7");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      await act(async () => more.click());
      expect(more.textContent).toBe("Show top 5");
      expect(list.querySelector("#fnm-report-categories")!.classList.contains("is-open")).toBe(
        true
      );
      expect(region("Spending by payee").querySelector("[aria-controls]")).toBeNull();
    } finally {
      results["finance.reports.spending"] = original;
    }
  });
});

describe("Reports with shared household spending", () => {
  const original = results["finance.reports.spending"];
  const withShared = (outflowCents: number, ownOutflowCents = 30_000) => ({
    ...currency,
    window: periods,
    own: [
      month("2026-08", 100_000, 50_000),
      month("2026-09", 200_000, 150_000),
      month("2026-10", 0, ownOutflowCents)
    ],
    shared: [
      {
        ownerUserId: "u2",
        months: [month("2026-08", 0, 0), month("2026-09", 0, 0), month("2026-10", 0, outflowCents)]
      }
    ],
    categories: []
  });
  const household: DirectoryReply = async () => ({
    ok: true,
    json: async () => ({ users: [{ id: "u2", name: "Sam" }] })
  });
  const failed: DirectoryReply = async () => ({ ok: false, json: async () => ({}) });
  const legend = () =>
    [...region("Cash flow").querySelectorAll(".jds-chart__legend-item")].map(
      (item) => item.textContent
    );
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

  afterEach(() => {
    results["finance.reports.spending"] = original;
  });

  it("holds the spending section until the household list has loaded", async () => {
    results["finance.reports.spending"] = withShared(20_000);
    let release!: () => void;
    directoryReplies = [
      () =>
        new Promise((resolve) => {
          release = () => resolve(household());
        })
    ];
    await mount();
    expect(document.querySelector('section[aria-label="Cash flow"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Includes shared household accounts");
    await act(async () => release());
    await act(async () => {});
    expect(legend()).toEqual(["Income$3,000.00", "Outflow$2,500.00", "Net$500.00"]);
    expect(document.body.textContent).toContain("Includes shared household accounts");
  });

  it("says shared spending is unavailable when the household list fails, and retries", async () => {
    results["finance.reports.spending"] = withShared(20_000);
    directoryReplies = [failed, household];
    await mount();
    expect(document.body.textContent).toContain("Shared household spending is unavailable.");
    expect(document.body.textContent).not.toContain("Includes shared household accounts");
    expect(legend()).toEqual(["Income$3,000.00", "Outflow$2,300.00", "Net$700.00"]);
    await act(async () => button("Try again").click());
    await act(async () => {});
    expect(directoryReads).toBe(2);
    expect(document.body.textContent).not.toContain("Shared household spending is unavailable.");
    expect(document.body.textContent).toContain("Includes shared household accounts");
    expect(legend()).toEqual(["Income$3,000.00", "Outflow$2,500.00", "Net$500.00"]);
  });

  it("reads the household list again on Refresh", async () => {
    results["finance.reports.spending"] = withShared(20_000);
    directoryReplies = [household];
    await mount();
    expect(directoryReads).toBe(1);
    await act(async () => button("Refresh").click());
    await act(async () => {});
    expect(directoryReads).toBe(2);
    expect(legend()).toEqual(["Income$3,000.00", "Outflow$2,500.00", "Net$500.00"]);
  });

  it("reads Unavailable, not a broken screen, when combined amounts are too large to add", async () => {
    results["finance.reports.spending"] = withShared(10, Number.MAX_SAFE_INTEGER - 5);
    directoryReplies = [household];
    await mount();
    expect(document.body.textContent).toContain("Spending is unavailable");
    expect(document.querySelector('section[aria-label="Cash flow"]')).toBeNull();
    expect(region("Net worth")).not.toBeNull();
  });
});
