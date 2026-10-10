import { expect, test } from "@playwright/test";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import { createMockCalendarEvent } from "./mock-calendar-email-api.js";

// Synthetic browser fixtures verify UI layout; they are not live-path UAT.
for (const [view, width] of [
  ["week", 390],
  ["week", 320],
  ["month", 390],
  ["month", 320]
] as const) {
  test(`${view} at ${width}px stays selected and scrolls within its calendar region`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((selected) => {
      localStorage.setItem("moss.cal.view", selected);
      localStorage.setItem("moss.cal.cursor", "2026-09-10T00:00:00Z");
    }, view);
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: [],
      calendarEvents: [
        createMockCalendarEvent("event-design", "Protected writing block", {
          startsAt: "2026-09-10T10:00:00Z",
          endsAt: "2026-09-10T11:00:00Z",
          isMossBlock: true
        })
      ]
    });
    await page.goto("/calendar");
    const region = page.getByRole("region", { name: `Calendar ${view}` });
    await expect(region).toBeVisible();
    const metrics = await region.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
      page: document.documentElement.scrollWidth,
      viewport: innerWidth
    }));
    expect(metrics.scroll).toBeGreaterThan(metrics.width);
    expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: view === "week" ? "Week" : "Month", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    const controlBounds = await page.locator(".cal-toolbar button").evaluateAll((buttons) =>
      buttons.map((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      })
    );
    expect(controlBounds.every(Boolean)).toBe(true);
    const tiny = await page
      .locator(".cal-body")
      .evaluate((el) =>
        [...el.querySelectorAll("*")]
          .filter(
            (node) =>
              !node.children.length &&
              node.textContent?.trim() &&
              parseFloat(getComputedStyle(node).fontSize) < 11
          )
          .map((node) => node.className)
      );
    expect(tiny).toEqual([]);
    await page.getByRole("button", { name: "Day", exact: true }).click();
    expect(
      await page
        .getByRole("region", { name: "Calendar day" })
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    ).toBe(true);
  });
}
