// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { BriefingDialog } from "../../apps/web/src/today/briefing-dialog.js";
import { BriefingReportShell } from "../../apps/web/src/today/briefing-report-shell.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const liveRoots: ReturnType<typeof createRoot>[] = [];
const addedNodes: Element[] = [];
const originalMatchMedia =
  typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined;

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    })
  });
}

afterEach(async () => {
  await act(async () => {
    for (const root of liveRoots.splice(0)) root.unmount();
  });
  for (const node of addedNodes.splice(0)) node.remove();
  if (originalMatchMedia === undefined) {
    Reflect.deleteProperty(window, "matchMedia");
  } else {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  }
});

async function renderShell(
  options: {
    readonly matchesWide?: boolean;
    readonly reviewLabel?: string;
    readonly onSelectReviewTab?: (event: { currentTarget: HTMLElement }) => void;
    readonly selectedTab?: "briefing" | "review";
    readonly onSelectBriefingTab?: (event: { currentTarget: HTMLElement }) => void;
    readonly footerStatus?: unknown;
  } = {}
) {
  stubMatchMedia(options.matchesWide ?? true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  addedNodes.push(container);
  const root = createRoot(container);
  liveRoots.push(root);
  const onSelectReviewTab = options.onSelectReviewTab ?? (() => undefined);
  await act(async () => {
    root.render(
      createElement(BriefingReportShell, {
        eyebrow: "Moss / Morning briefing",
        title: "Your day, prepared.",
        opener: null,
        onClose: () => undefined,
        reviewTabLabel: options.reviewLabel ?? "Review task blocks",
        onSelectReviewTab,
        selectedTab: options.selectedTab,
        onSelectBriefingTab: options.onSelectBriefingTab,
        jumpLinks: null,
        report: createElement("p", null, "Report paragraph"),
        railDateInput: "2026-09-10T13:45:00.000Z",
        locale: { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" },
        railHeading: "Your day, in order.",
        rail: createElement("p", null, "Rail paragraph"),
        footerActions: createElement("button", { type: "button" }, "Adjust task blocks"),
        footerBack: createElement("button", { type: "button" }, "Back to Today"),
        footerStatus:
          options.footerStatus === undefined
            ? undefined
            : createElement("p", null, options.footerStatus as string)
      })
    );
  });
  return container;
}

function keyDown(target: Element, key: string) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("BriefingDialog without report props", () => {
  it("renders no eyebrow or nav and keeps the plain surface class", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    addedNodes.push(container);
    const root = createRoot(container);
    liveRoots.push(root);
    await act(async () => {
      root.render(
        createElement(BriefingDialog, {
          title: "Review task blocks",
          opener: null,
          onClose: () => undefined,
          footer: createElement("button", { type: "button" }, "Close"),
          children: createElement("p", null, "Body")
        })
      );
    });
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.className).toBe("brief-reader");
    expect(dialog.querySelector(".brief-reader__eyebrow")).toBeNull();
    expect(dialog.querySelector('[role="tablist"]')).toBeNull();
  });
});

describe("BriefingReportShell tabs", () => {
  it("renders a named tablist with roving tabs wired to the report panel", async () => {
    await renderShell();
    const tablist = document.body.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist.getAttribute("aria-label")).toBe("Morning briefing views");
    const tabs = [...document.body.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["The briefing", "Review task blocks"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(panel.textContent).toContain("Report paragraph");
  });

  it("moves focus with arrows, Home and End without activating", async () => {
    const selected: HTMLElement[] = [];
    await renderShell({ onSelectReviewTab: (event) => selected.push(event.currentTarget) });
    const [briefing, review] = [...document.body.querySelectorAll('[role="tab"]')] as [
      HTMLButtonElement,
      HTMLButtonElement
    ];
    await act(async () => briefing.focus());
    await act(async () => keyDown(briefing, "ArrowRight"));
    expect(document.activeElement).toBe(review);
    await act(async () => keyDown(review, "ArrowLeft"));
    expect(document.activeElement).toBe(briefing);
    await act(async () => keyDown(briefing, "End"));
    expect(document.activeElement).toBe(review);
    await act(async () => keyDown(review, "Home"));
    expect(document.activeElement).toBe(briefing);
    expect(selected).toHaveLength(0);
  });

  it("hands the review tab to the same review entry as the footer", async () => {
    const selected: HTMLElement[] = [];
    await renderShell({ onSelectReviewTab: (event) => selected.push(event.currentTarget) });
    const review = [...document.body.querySelectorAll('[role="tab"]')].at(1) as HTMLButtonElement;
    await act(async () => review.click());
    expect(selected).toEqual([review]);
  });
});

describe("BriefingReportShell schedule disclosure", () => {
  it("starts open on desktop and toggles region visibility from the button", async () => {
    await renderShell({ matchesWide: true });
    const toggle = document.body.querySelector(
      ".brief-reader__schedule-toggle"
    ) as HTMLButtonElement;
    expect(toggle.textContent).toBe("Today's schedule");
    const region = document.body.querySelector(".brief-reader__rail") as HTMLElement;
    expect(toggle.getAttribute("aria-controls")).toBe(region.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(region.hasAttribute("hidden")).toBe(false);
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region.hasAttribute("hidden")).toBe(true);
  });

  it("renders the schedule before the report on the phone", async () => {
    await renderShell({ matchesWide: false });
    const toggle = document.body.querySelector(".brief-reader__schedule-toggle") as HTMLElement;
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(toggle.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the schedule after the report on desktop", async () => {
    await renderShell({ matchesWide: true });
    const toggle = document.body.querySelector(".brief-reader__schedule-toggle") as HTMLElement;
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(toggle.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("starts closed on the phone", async () => {
    await renderShell({ matchesWide: false });
    const toggle = document.body.querySelector(
      ".brief-reader__schedule-toggle"
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.body.querySelector(".brief-reader__rail") as HTMLElement;
    expect(region.hasAttribute("hidden")).toBe(true);
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(region.hasAttribute("hidden")).toBe(false);
    expect(region.textContent).toContain("Your day, in order.");
  });
});

describe("BriefingReportShell footer status", () => {
  it("renders no status strip when the slot is absent", async () => {
    await renderShell();
    const footer = document.body.querySelector(".brief-reader__footer") as HTMLElement;
    expect(footer.querySelector(".brief-reader__status")).toBeNull();
  });

  it("omits the with-status footer class when the slot is absent", async () => {
    await renderShell();
    const footer = document.body.querySelector(".brief-reader__footer") as HTMLElement;
    expect(footer.classList.contains("brief-reader__footer--with-status")).toBe(false);
  });

  it("adds the with-status footer class when the slot is filled", async () => {
    await renderShell({ footerStatus: "Added 1 to the calendar" });
    const footer = document.body.querySelector(".brief-reader__footer") as HTMLElement;
    expect(footer.classList.contains("brief-reader__footer--with-status")).toBe(true);
  });

  it("renders the strip as the footer's first child, ahead of the actions box", async () => {
    await renderShell({ footerStatus: "Added 1 to the calendar" });
    const footer = document.body.querySelector(".brief-reader__footer") as HTMLElement;
    const strip = footer.querySelector(".brief-reader__status") as HTMLElement;
    expect(strip.textContent).toContain("Added 1 to the calendar");
    expect(footer.firstElementChild).toBe(strip);
    const actions = footer.querySelector(".brief-reader__footer-actions") as HTMLElement;
    expect(strip.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("BriefingReportShell selected tab", () => {
  it("selects the briefing tab by default with the panel labelled by it", async () => {
    await renderShell();
    const briefing = document.body.querySelectorAll('[role="tab"]')[0] as HTMLElement;
    const review = document.body.querySelectorAll('[role="tab"]')[1] as HTMLElement;
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(briefing.getAttribute("aria-selected")).toBe("true");
    expect(briefing.tabIndex).toBe(0);
    expect(review.getAttribute("aria-selected")).toBe("false");
    expect(review.tabIndex).toBe(-1);
    expect(panel.getAttribute("aria-labelledby")).toBe(briefing.id);
  });

  it("selects the review tab and hands the briefing tab back to the caller", async () => {
    const seen: HTMLElement[] = [];
    await renderShell({
      selectedTab: "review",
      onSelectBriefingTab: (event) => seen.push(event.currentTarget)
    });
    const briefing = document.body.querySelectorAll('[role="tab"]')[0] as HTMLElement;
    const review = document.body.querySelectorAll('[role="tab"]')[1] as HTMLElement;
    const panel = document.body.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(review.tabIndex).toBe(0);
    expect(briefing.getAttribute("aria-selected")).toBe("false");
    expect(briefing.tabIndex).toBe(-1);
    expect(panel.getAttribute("aria-labelledby")).toBe(review.id);
    await act(async () => briefing.click());
    expect(seen).toEqual([briefing]);
  });
});
