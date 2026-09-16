import { expect, test, type Page } from "@playwright/test";

import {
  createMockBriefingDefinition,
  createMockBriefingRun,
  createMockConnectorProviders,
  createMockTask,
  mockApi
} from "./mock-api.js";
import {
  mockDayPlanBlock,
  mockDayPlanTask,
  registerMockDayPlanRoutes
} from "./mock-day-plan-api.js";
import { seedTodayChrome } from "./today-page-chrome.js";

const NOW = "2026-09-10T16:00:00.000Z";
const DAY = "2026-09-10";
const PROSE =
  "Protect the launch window and reply to Alex about the contract deadline. " +
  "The morning review covers the deployment checklist and the vendor statement.";

async function openReader(page: Page) {
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  await expect(page.getByRole("heading", { name: "Your day, prepared." })).toBeFocused();
}

async function seed(page: Page) {
  const morningDefinition = createMockBriefingDefinition("briefing-shell", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("shell-run-1", morningDefinition.id, PROSE, {
    briefingType: "morning",
    createdAt: NOW,
    sourceMetadata: {
      sourceTimestamps: {
        version: 1,
        capturedAt: NOW,
        sources: [{ source: "email", freshnessKind: "connector_sync", asOf: NOW }]
      }
    },
    structuredPayload: { version: 1, actionRows: [], catchUp: null }
  });
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    notifications: [],
    tasks: [createMockTask("t1", "Write the launch brief")],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition],
    briefingRuns: { [morningDefinition.id]: [run] },
    calendarEvents: []
  });
  await seedTodayChrome(page, DAY, "med-shell");
  await registerMockDayPlanRoutes(page, {
    plan: {
      id: "plan-shell",
      localDay: DAY,
      timeZone: "UTC",
      revision: 1,
      sourceRunId: null,
      eveningIntent: {
        priorityTaskIds: [],
        capacity: null,
        notes: null,
        corrections: [],
        commitments: []
      },
      blocks: [mockDayPlanBlock("b1", "t1", 0)]
    },
    tasks: [mockDayPlanTask("t1", "Write the launch brief")]
  });
}

test("report tabs move focus by keyboard and hand off to review", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page);
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  await openReader(page);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "The briefing" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // Title, then Close, then the selected tab.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("tab", { name: "The briefing" })).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Review task blocks" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(dialog.getByRole("tab", { name: "The briefing" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: "Review task blocks" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeHidden();
});

test("phone disclosure toggles the schedule without sideways scroll", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 375, height: 900 });
  await seed(page);
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  await openReader(page);

  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("button", { name: "Today's schedule" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText("Your day, in order.")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 375px with the schedule open"
  ).toBe(true);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 320px"
  ).toBe(true);
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll(".brief-reader *")]
      .filter((node) => {
        const style = getComputedStyle(node as HTMLElement);
        return !(style.textOverflow === "ellipsis" && style.overflow !== "visible");
      })
      .filter((node) => (node as HTMLElement).scrollWidth > (node as HTMLElement).clientWidth + 1)
      .map((node) => (node as HTMLElement).className.toString().split(" ")[0])
  );
  expect(overflow, "no dialog descendant wider than its box at 320px").toEqual([]);
  const footer = await page.evaluate(() => {
    const bar = document.querySelector(
      ".brief-reader--report .brief-reader__footer"
    ) as HTMLElement;
    const back = document.querySelector(".brief-reader__footer-back") as HTMLElement;
    const actions = document.querySelector(".brief-reader__footer-actions") as HTMLElement;
    const backRect = back.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    return {
      columns: getComputedStyle(bar).gridTemplateColumns.split(" ").length,
      stacked: backRect.bottom <= actionsRect.top || backRect.top >= actionsRect.bottom
    };
  });
  expect(footer.columns, "report footer is one column at 320px").toBe(1);
  expect(footer.stacked, "footer zones stack at 320px").toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Read the full morning briefing" })).toBeFocused();
});
