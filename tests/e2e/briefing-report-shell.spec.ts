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

async function seed(page: Page, prose: string = PROSE) {
  const morningDefinition = createMockBriefingDefinition("briefing-shell", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("shell-run-1", morningDefinition.id, prose, {
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
  await expect(page.getByRole("heading", { name: "Your day, prepared." })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Make the plan fit." })).toBeHidden();
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
  // The open phone schedule shows its rows without the rail heading, as in the prototype.
  await expect(dialog.locator(".brief-reader__rail")).toBeVisible();
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
      lone: actions.children.length === 1,
      columns: getComputedStyle(bar).gridTemplateColumns.split(" ").length,
      stacked: backRect.bottom <= actionsRect.top || backRect.top >= actionsRect.bottom,
      sideBySide: backRect.right <= actionsRect.left
    };
  });
  // A lone action shares one row with Back, as in the prototype; more actions stack.
  if (footer.lone) {
    expect(footer.columns, "report footer is two columns at 320px").toBe(2);
    expect(footer.sideBySide, "Back and the lone action sit side by side at 320px").toBe(true);
  } else {
    expect(footer.columns, "report footer is one column at 320px").toBe(1);
    expect(footer.stacked, "footer zones stack at 320px").toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Read the full morning briefing" })).toBeFocused();
});

test("desktop 200 percent zoom keeps footer reachable without overlap", async ({ page }) => {
  // A 1440x900 desktop screen at 200 percent browser zoom lays out at
  // 720x450 CSS px, so emulate with that viewport.
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 720, height: 450 });
  await seed(page, `${PROSE} ${(PROSE + " ").repeat(14)}`);
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  await openReader(page);

  const dialog = page.getByRole("dialog");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 200 percent zoom"
  ).toBe(true);
  const geometry = await page.evaluate(() => {
    const body = document.querySelector(".brief-reader__body") as HTMLElement;
    body.scrollTop = body.scrollHeight;
    const footer = document.querySelector(
      ".brief-reader--report .brief-reader__footer"
    ) as HTMLElement;
    const back = document.querySelector(".brief-reader__footer-back") as HTMLElement;
    const actions = document.querySelector(".brief-reader__footer-actions") as HTMLElement;
    const report = document.querySelector(".brief-reader__report") as HTMLElement;
    const last = report.lastElementChild as HTMLElement;
    const backRect = back.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      backVisible: backRect.top >= 0 && backRect.bottom <= window.innerHeight,
      actionsVisible: actionsRect.top >= 0 && actionsRect.bottom <= window.innerHeight,
      overlap:
        backRect.left < actionsRect.right &&
        actionsRect.left < backRect.right &&
        backRect.top < actionsRect.bottom &&
        actionsRect.top < backRect.bottom,
      lastBottom: last.getBoundingClientRect().bottom,
      footerTop: footerRect.top
    };
  });
  expect(geometry.backVisible, "Back visible at 200 percent zoom").toBe(true);
  expect(geometry.actionsVisible, "actions visible at 200 percent zoom").toBe(true);
  expect(geometry.overlap, "Back and actions do not overlap").toBe(false);
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.footerTop + 1);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("end-scrolled report clears the footer on a short phone screen", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 375, height: 500 });
  await seed(page, `${PROSE} ${(PROSE + " ").repeat(14)}`);
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  await openReader(page);

  const geometry = await page.evaluate(() => {
    const body = document.querySelector(".brief-reader__body") as HTMLElement;
    body.scrollTop = body.scrollHeight;
    const footer = document.querySelector(
      ".brief-reader--report .brief-reader__footer"
    ) as HTMLElement;
    const report = document.querySelector(".brief-reader__report") as HTMLElement;
    const last = report.lastElementChild as HTMLElement;
    return {
      scrollable: body.scrollHeight > body.clientHeight + 1,
      lastBottom: last.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      footerBottom: footer.getBoundingClientRect().bottom,
      innerHeight: window.innerHeight
    };
  });
  expect(geometry.scrollable, "report exceeds the phone body").toBe(true);
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.innerHeight + 1);
});
