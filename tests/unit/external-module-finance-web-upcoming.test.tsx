// @vitest-environment jsdom
//
// The Upcoming screen in a real DOM: month totals, the bill calendar, the week-grouped list, the
// bill panel opened from a calendar chip, and suggested bills. Server data comes through a faked
// fetch at the network edge in each read tool's own shape; the screen and store run for real.
import "./helpers/install-module-runtime";
import type { ExternalModuleToolsHandleV1, ModuleToolOutcome } from "@moss/module-web-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpcomingScreen } from "../../external-modules/finance/src/web/screens/upcoming";
import { __resetStoreForTests } from "../../external-modules/finance/src/web/store";

const review = { revision: 4, fingerprint: "b".repeat(32) };
const occurrence = (
  planId: string,
  name: string,
  date: string,
  expectedCents: number,
  state: "projected" | "posted" | "skipped" | "review",
  actualCents: number | null = null
) => ({
  planId,
  name,
  accountId: "cash",
  categoryId: "bills",
  dueDate: date,
  plannedDate: date,
  canAdjust: state === "projected",
  canRecordEntry: false,
  expectedCents,
  state,
  actualCents,
  transactionId: actualCents === null ? null : `t-${planId}`
});
const plan = (id: string, name: string) => ({
  id,
  name,
  accountId: "cash",
  categoryId: "bills",
  isoCurrency: "USD",
  amountCents: 100,
  anchorDate: "2026-01-01",
  cadence: "monthly"
});

// November 2026 starts on a Sunday; today is the 10th.
const bills = (withPlans: boolean) => ({
  status: "ok",
  today: "2026-11-10",
  isoCurrency: "USD",
  ...review,
  plans: withPlans ? [plan("rent", "Rent"), plan("power", "Power")] : [],
  occurrences: withPlans
    ? [
        occurrence("rent", "Rent", "2026-11-01", 185_000, "posted", 185_000),
        occurrence("power", "Power", "2026-11-05", 9_000, "projected"),
        occurrence("phone", "Phone", "2026-11-12", 6_000, "review"),
        occurrence("film", "Film Club", "2026-11-15", 1_599, "projected"),
        occurrence("gym", "Gym", "2026-11-20", 4_000, "skipped")
      ]
    : [],
  accounts: [{ accountId: "cash", name: "Checking" }],
  categories: [
    { id: "bills", name: "Bills" },
    { id: "subscriptions", name: "Subscriptions" }
  ],
  transactions: []
});
const stream = {
  accountId: "cash",
  accountName: "Checking",
  payeeKey: "synthetic stream",
  name: "Synthetic Stream",
  cadence: "monthly",
  amountCents: 1_299,
  categoryId: "subscriptions",
  lastDate: "2026-10-16",
  nextDate: "2026-11-16"
};

let results: Record<string, unknown> = {};
// When set, reads wait for it: the screen keeps showing the earlier read meanwhile.
let hold: Promise<void> | null = null;

function fakeFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (hold) await hold;
      const tool = decodeURIComponent(/assistant-tools\/([^/]+)\/invoke/.exec(url)?.[1] ?? "");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () =>
          url === "/api/users/directory"
            ? { users: [] }
            : { invocation: { status: "succeeded", result: results[tool] } }
      };
    })
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const succeeded = (): ExternalModuleToolsHandleV1 => ({
  invoke: vi.fn(
    async (): Promise<ModuleToolOutcome> =>
      ({ status: "succeeded", result: { status: "ok" } }) as ModuleToolOutcome
  )
});

async function mount(tools: ExternalModuleToolsHandleV1 = succeeded()) {
  fakeFetch();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<UpcomingScreen tools={tools} />));
  await act(async () => {});
  await act(async () => {});
  return tools;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
  results = {
    "finance.bills.read": bills(true),
    "finance.bills.suggestions": { status: "ok", isoCurrency: "USD", suggestions: [stream] }
  };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  hold = null;
  __resetStoreForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function click(target: Element) {
  await act(async () => {
    (target as HTMLElement).click();
  });
  await act(async () => {});
}

const buttons = (scope: ParentNode = document) => [...scope.querySelectorAll("button")];
const button = (label: string, scope: ParentNode = document) =>
  buttons(scope).find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label
  )!;
const chip = (label: string) =>
  document.querySelector<HTMLButtonElement>(`.cal-mchip[aria-label="${label}"]`)!;
const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent);

describe("Upcoming bills", () => {
  it("totals the month: paid uses the actual amount and skipped bills count nowhere", async () => {
    await mount();
    expect(document.querySelector(".jds-section-head")?.textContent).toContain(
      "$2,015.99 due · $1,850.00 paid · $165.99 to go"
    );
  });

  it("puts each bill on its day with its state in the chip's name", async () => {
    await mount();
    expect(chip("Rent, Nov 1, $1,850.00, paid").className).toContain("is-muted");
    expect(chip("Power, Nov 5, $90.00, past due")).toBeTruthy();
    expect(chip("Phone, Nov 12, $60.00, match needs review")).toBeTruthy();
    expect(chip("Film Club, Nov 15, $15.99, due")).toBeTruthy();
    expect(chip("Gym, Nov 20, $40.00, skipped").className).toContain("is-struck");
    // Five weeks, Sunday first, with no trailing week of December.
    expect(document.querySelectorAll(".cal-month--fit .cal-mcell")).toHaveLength(35);
  });

  it("lists bills by week with readable dates", async () => {
    await mount();
    expect(text(".fnm-week > h3")).toEqual(["Nov 1 – Nov 7", "Nov 8 – Nov 14", "Nov 15 – Nov 21"]);
    const first = document.querySelector(".fnm-week")!;
    expect(
      [...first.querySelectorAll(".jds-index__title")].map((node) => node.textContent)
    ).toEqual(["Rent", "Power"]);
    expect(first.querySelector(".jds-index__excerpt")?.textContent).toBe(
      "Sun, Nov 1 · Checking · Bills"
    );
  });

  it("opens a bill from its chip and acts on it from the panel", async () => {
    const tools = await mount();
    await click(chip("Power, Nov 5, $90.00, past due"));
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.querySelector("h2")?.textContent).toBe("Power");
    expect(panel.textContent).toContain("Past due · projected");
    await click(button("Skip occurrence", panel));
    expect(tools.invoke).toHaveBeenCalledWith("finance.bill.decide", {
      planId: "power",
      dueDate: "2026-11-05",
      state: "skipped",
      expectedRevision: review.revision,
      expectedFingerprint: review.fingerprint
    });
  });

  it("badges only bills that need a look, and opens any row's panel from Details", async () => {
    await mount();
    const row = (name: string) =>
      [...document.querySelectorAll(".fnm-week .jds-index__row")].find(
        (node) => node.querySelector(".jds-index__title")?.textContent === name
      )!;
    expect(row("Film Club").querySelector(".jds-badge")).toBeNull();
    expect(row("Power").querySelector(".jds-badge")?.textContent).toBe("Past due · projected");
    await click(button("Details, Film Club, Nov 15"));
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.querySelector("h2")?.textContent).toBe("Film Club");
    expect(panel.textContent).toContain("Projected");
  });

  it("lists each plan with its amount and puts stopped plans last without actions", async () => {
    results["finance.bills.read"] = {
      ...bills(true),
      plans: [
        { ...plan("gym", "Gym"), amountCents: 4_000, endDate: "2026-10-31" },
        { ...plan("rent", "Rent"), amountCents: 185_000 },
        { ...plan("power", "Power"), amountCents: 9_000, endDate: "2027-03-05" }
      ]
    };
    await mount();
    const head = [...document.querySelectorAll(".jds-section-head__title")].find(
      (node) => node.textContent === "Your bill plans"
    )!;
    const rows = [...head.closest(".fnm-block")!.querySelectorAll(".jds-index__row")];
    const cell = (row: Element, part: string) =>
      row.querySelector(`.jds-index__${part}`)?.textContent;
    expect(rows.map((row) => cell(row, "title"))).toEqual(["Rent", "Power", "Gym"]);
    expect(rows.map((row) => row.querySelector(".fnm-amount")?.textContent)).toEqual([
      "$1,850.00",
      "$90.00",
      "$40.00"
    ]);
    expect(cell(rows[1]!, "excerpt")).toContain("· stops after Mar 5, 2027");
    expect(cell(rows[2]!, "excerpt")).toContain("· stopped after Oct 31, 2026");
    expect(rows[2]!.querySelector("button")).toBeNull();
  });

  it("stops a plan from its row menu", async () => {
    const tools = await mount();
    await click(button("Actions for Rent"));
    await click(button("Stop future bills for Rent"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector(".jds-dialog__title")?.textContent).toBe("Stop future bills");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Last planned date"]')!.value).toBe(
      "2026-11-10"
    );
    await click(button("Save last planned date", dialog));
    expect(tools.invoke).toHaveBeenCalledWith("finance.bill.stop", {
      id: "rent",
      endDate: "2026-11-10",
      expectedRevision: review.revision,
      expectedFingerprint: review.fingerprint
    });
  });

  it("keeps the last date on or after the plan's latest reviewed or changed bill", async () => {
    const data = bills(true);
    results["finance.bills.read"] = {
      ...data,
      occurrences: [
        ...data.occurrences,
        {
          ...occurrence("rent", "Rent", "2026-11-22", 185_000, "projected"),
          plannedDate: "2026-11-24",
          adjusted: true
        }
      ]
    };
    const tools = await mount();
    await click(button("Actions for Rent"));
    await click(button("Stop future bills for Rent"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const date = dialog.querySelector<HTMLInputElement>('[aria-label="Last planned date"]')!;
    expect(date.value).toBe("2026-11-10");
    expect(date.min).toBe("2026-11-24");
    expect(button("Save last planned date", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain(
      "Undo the reviewed or changed bill on Nov 24, 2026 first, or choose that date or later."
    );
    await click(button("Save last planned date", dialog));
    expect(tools.invoke).not.toHaveBeenCalled();
  });

  it("dismisses a suggestion with its key fields and no question", async () => {
    const tools = await mount();
    const section = document.querySelector('section[aria-label="Suggested bills"]')!;
    expect(section.querySelector(".jds-index__excerpt")?.textContent).toBe(
      "Every month · last charged Oct 16 · Checking"
    );
    await click(button("Dismiss Synthetic Stream", section));
    expect(tools.invoke).toHaveBeenCalledWith("finance.bills.suggestions.dismiss", {
      accountId: "cash",
      payeeKey: "synthetic stream",
      cadence: "monthly",
      amountCents: 1_299
    });
  });

  it("fills the Add a bill form from a suggestion", async () => {
    await mount();
    await click(button("Add as bill, Synthetic Stream"));
    const form = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const value = (label: string) =>
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!.value;
    expect(value("Bill name")).toBe("Synthetic Stream");
    expect(value("Bill account")).toBe("cash");
    expect(value("Bill category")).toBe("subscriptions");
    // The visible label names the amount field; no separate accessible name overrides it.
    const amount = [...form.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Expected amount"))
      ?.querySelector("input");
    expect(amount?.value).toBe("12.99");
    expect(amount?.hasAttribute("aria-label")).toBe(false);
    expect(value("First planned date")).toBe("2026-11-16");
    expect(value("Bill repeats")).toBe("monthly");
  });

  it("holds bill actions until the read after a save lands", async () => {
    await mount();
    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    await click(button("Add as bill, Synthetic Stream"));
    await click(button("Save bill plan"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Add a bill").disabled).toBe(true);
    expect(button("Add as bill, Synthetic Stream").disabled).toBe(true);
    await act(async () => release());
    await act(async () => {});
    expect(button("Add a bill").disabled).toBe(false);
    expect(button("Add as bill, Synthetic Stream").disabled).toBe(false);
  });

  it("shows suggestions instead of the empty page when there are no plans yet", async () => {
    results["finance.bills.read"] = bills(false);
    await mount();
    expect(document.querySelector('section[aria-label="Suggested bills"]')).toBeTruthy();
    expect(button("Add a bill")).toBeTruthy();
    expect(document.body.textContent).not.toContain("No bills yet");
  });

  it("shows the empty page when there are no plans and nothing to suggest", async () => {
    results["finance.bills.read"] = bills(false);
    results["finance.bills.suggestions"] = { status: "ok", isoCurrency: "USD", suggestions: [] };
    await mount();
    expect(document.body.textContent).toContain("No bills yet");
    expect(document.querySelector('section[aria-label="Suggested bills"]')).toBeNull();
  });

  it("names every row action after its bill and day", async () => {
    await mount();
    const row = [...document.querySelectorAll(".fnm-week .jds-index__row")].find(
      (node) => node.querySelector(".jds-index__title")?.textContent === "Power"
    )!;
    expect(buttons(row).map((candidate) => candidate.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining([
        "Match posted, Power, Nov 5",
        "Skip occurrence, Power, Nov 5",
        "Change this occurrence, Power, Nov 5",
        "Details, Power, Nov 5"
      ])
    );
  });
});

describe("the bill panel hands over to the dialogs it opens", () => {
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const panelOpen = () => document.getElementById("fnm-bill-title") !== null;
  const withRecordablePower = () => {
    results["finance.bills.read"] = {
      ...bills(true),
      occurrences: bills(true).occurrences.map((o) => ({
        ...o,
        canRecordEntry: o.planId === "power"
      }))
    };
  };

  it.each([
    ["Change this occurrence", "Change this occurrence"],
    ["Record bill entry", "Record bill entry"],
    ["Match posted", "Match a posted transaction"]
  ])(
    "closes the panel when %s opens its dialog and returns focus to the chip on cancel",
    async (action, title) => {
      withRecordablePower();
      await mount();
      const opener = chip("Power, Nov 5, $90.00, past due");
      opener.focus();
      await click(opener);
      expect(panelOpen()).toBe(true);
      await click(button(action, dialogs()[0]!));
      expect(panelOpen()).toBe(false);
      expect(dialogs()).toHaveLength(1);
      expect(dialogs()[0]!.querySelector(".jds-dialog__title")?.textContent).toBe(title);
      await click(button("Cancel", dialogs()[0]!));
      expect(dialogs()).toHaveLength(0);
      expect(document.activeElement).toBe(opener);
    }
  );

  it("returns focus to the Details button that opened the panel", async () => {
    await mount();
    const details = button("Details, Power, Nov 5");
    await click(details);
    await click(button("Match posted", dialogs()[0]!));
    expect(panelOpen()).toBe(false);
    await click(button("Cancel", dialogs()[0]!));
    expect(document.activeElement).toBe(details);
  });

  it("returns focus to a row's own button when a row opens the dialog after a panel did", async () => {
    await mount();
    const opener = chip("Power, Nov 5, $90.00, past due");
    opener.focus();
    await click(opener);
    await click(button("Change this occurrence", dialogs()[0]!));
    await click(button("Cancel", dialogs()[0]!));
    const rowButton = button("Change this occurrence, Film Club, Nov 15");
    rowButton.focus();
    await click(rowButton);
    expect(dialogs()).toHaveLength(1);
    await click(button("Cancel", dialogs()[0]!));
    expect(document.activeElement).toBe(rowButton);
  });
});
