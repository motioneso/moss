import { expect, test, type Page } from "@playwright/test";

import {
  createMockBriefingDefinition,
  createMockBriefingRun,
  createMockConnectorProviders,
  createMockTask,
  mockApi,
  type MockApiState
} from "./mock-api.js";

const NOW = "2026-09-10T16:00:00.000Z";
const QUIET = "Nothing else yet today";

async function openToday(
  page: Page,
  options: { readonly withTask: boolean; readonly briefing: boolean; readonly evening?: boolean }
): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW));
  const morning = createMockBriefingDefinition("briefing-morning", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const evening = createMockBriefingDefinition("briefing-evening", "Evening", {
    briefingType: "evening",
    cadence: "daily",
    scheduleMetadata: { targetTime: "23:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun(
    "morning-run-1",
    morning.id,
    "A calm day. Nothing needs you before noon.",
    {
      briefingType: "morning",
      createdAt: NOW,
      structuredPayload: { version: 1, actionRows: [], catchUp: null }
    }
  );
  const state: MockApiState = {
    authenticated: true,
    onboardingStatus: {
      role: "founder",
      state: "completed",
      steps: {
        cliAuth: {
          done: true,
          providers: [{ kind: "anthropic", cliPresent: true, installState: "ready" }]
        },
        connectors: { done: false }
      }
    },
    chatThreads: [],
    notifications: [],
    tasks: options.withTask ? [createMockTask("task-quiet", "Send the invoice")] : [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: options.evening === false ? [morning] : [morning, evening],
    briefingRuns: { [morning.id]: options.briefing ? [run] : [], [evening.id]: [] },
    calendarEvents: []
  };
  await mockApi(page, state);
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test.describe(`quiet line at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("all empty: one quiet line replaces the three empty sections", async ({ page }) => {
      await openToday(page, { withTask: false, briefing: false });
      const line = page.locator(".today-quiet-line");
      await expect(line).toContainText(QUIET);
      await expect(page.getByText("The few things that matter most")).toHaveCount(0);
      await expect(page.getByText("No evening review yet.")).toHaveCount(0);

      // The line keeps the section gap from the hero above and the content below.
      const gaps = await line.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const above = el.previousElementSibling?.getBoundingClientRect();
        const below = el.nextElementSibling?.getBoundingClientRect();
        return {
          above: above ? box.top - above.bottom : null,
          below: below ? below.top - box.bottom : null
        };
      });
      if (gaps.above !== null) expect(gaps.above).toBeGreaterThanOrEqual(20);
      if (gaps.below !== null) expect(gaps.below).toBeGreaterThanOrEqual(32);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);

      // No fixed-position product element covers the line. The dev-only note toolbar
      // (its layers carry styles-module__ class names) is excluded because it never ships.
      const covering = await line.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [...document.querySelectorAll("body *")]
          .filter((other) => getComputedStyle(other).position === "fixed")
          .filter(
            (other) =>
              !other.contains(el) &&
              !other.closest("#agentation-root") &&
              !String(other.className).includes("styles-module__")
          )
          .map((other) => other.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .filter(
            (r) =>
              r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top
          ).length;
      });
      expect(covering).toBe(0);
    });

    test("no evening review set up: still one quiet line", async ({ page }) => {
      await openToday(page, { withTask: false, briefing: false, evening: false });
      await expect(page.locator(".today-quiet-line")).toContainText(QUIET);
      await expect(page.getByText("The few things that matter most")).toHaveCount(0);
    });

    test("partly empty: a task brings the sections back", async ({ page }) => {
      await openToday(page, { withTask: true, briefing: false });
      await expect(page.locator(".today-quiet-line")).toHaveCount(0);
      await expect(page.getByText("The few things that matter most")).toBeVisible();
      await expect(page.getByText("No evening review yet.")).toBeVisible();
    });

    test("partly empty: a briefing brings the sections back", async ({ page }) => {
      await openToday(page, { withTask: false, briefing: true });
      await expect(page.locator(".today-quiet-line")).toHaveCount(0);
      await expect(page.getByText("The few things that matter most")).toBeVisible();
    });
  });
}
