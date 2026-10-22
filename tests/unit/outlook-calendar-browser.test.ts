// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../packages/connectors/node_modules/playwright-core/index.mjs", () => ({
  chromium: { connectOverCDP: transport.connect }
}));

import { collectOutlookCalendar } from "../../packages/connectors/src/outlook-calendar-browser.js";

// Invented rendered browser observations. Keep the displayed week between CDP connections,
// just as the dedicated browser does between scheduled refreshes.
function calendarBrowser(secondary = false, shared = false) {
  const group = document.createElement("li");
  group.innerHTML = `<button><span>${shared ? "People’s calendars" : "My calendars"}</span></button><div><button role="option" aria-selected="true"><span>Calendar</span></button><button aria-label="More options"></button></div>`;
  const selected = group.querySelector('[role="option"]')!;
  let week = 0;
  const date = (offset: number) => new Date(Date.UTC(2026, 9, 19 + offset * 7));
  const monthDay = (value: Date) =>
    value.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const locator = (name: string) => {
    const control = {
      first: () => control,
      last: () => control,
      locator: (child: string) => locator(child),
      waitFor: async () => undefined,
      isVisible: async () => false,
      count: async () => (name.includes("main") || name.includes('aria-selected="true"') ? 1 : 0),
      allInnerTexts: async () =>
        name === '[role="menuitem"]'
          ? [
              "Show this only",
              "Sharing and permissions",
              "Color",
              "Move up",
              "Move down",
              "Move to",
              ...(secondary ? ["Delete"] : [])
            ]
          : ["invented@example.test"],
      innerText: async () => (name === "Select a language:" ? "English" : "Gregorian"),
      inputValue: async () => "(UTC-08:00) Pacific Time (US & Canada)",
      getAttribute: async () =>
        `${monthDay(date(week))} – ${monthDay(new Date(date(week + 1).getTime() - 86400000))}, 2026, Jump to a specific date or date range.`,
      evaluate: async (fn: (element: Element) => unknown) => {
        if (name.includes("Go to previous week")) week--;
        if (name.includes("Go to next week")) week++;
        if (name.includes('aria-selected="true"')) return fn(selected);
        if (name === "menu") return fn(document.createElement("div"));
        return [];
      },
      evaluateAll: async () => []
    };
    return control;
  };
  const page = {
    url: () => "https://outlook.office.com/calendar/view/week",
    locator,
    getByRole: (role: string, options?: { name: string }) => locator(options?.name ?? role),
    setDefaultTimeout: () => undefined,
    setViewportSize: async () => undefined,
    reload: async () => undefined,
    waitForFunction: async () => undefined,
    waitForTimeout: async () => undefined,
    context: () => ({
      newCDPSession: async () => ({
        send: async (method: string) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "invented" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          return { result: { value: false } };
        },
        detach: async () => undefined
      })
    })
  };
  return { contexts: () => [{ pages: () => [page] }], close: async () => undefined };
}

describe("Outlook browser refresh navigation", () => {
  it.each([
    [true, false],
    [false, true]
  ])("refuses secondary/shared same-name Calendar (%s, %s)", async (secondary, shared) => {
    transport.connect.mockResolvedValue(calendarBrowser(secondary, shared));
    await expect(
      collectOutlookCalendar(
        { endpoint: "http://127.0.0.1:5185", accountAddress: "invented@example.test" },
        new Date("2026-10-21T12:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "source-changed", stage: "calendar" });
  });
  it("completes consecutive full scans from the week left by the prior scan", async () => {
    transport.connect.mockResolvedValue(calendarBrowser());
    const binding = { endpoint: "http://127.0.0.1:5185", accountAddress: "invented@example.test" };
    const now = new Date("2026-10-21T12:00:00.000Z");
    for (let refresh = 0; refresh < 3; refresh++) {
      const scan = await collectOutlookCalendar(binding, now);
      expect(scan.complete).toBe(true);
      expect(scan.views).toBe(5);
      expect(scan.windowStart).toBe("2026-10-20");
      expect(scan.windowEnd).toBe("2026-11-21");
    }
  });
});
