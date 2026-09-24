import { expect, test } from "@playwright/test";

import {
  createMockBriefingDefinition,
  createMockBriefingRun,
  createMockConnectorProviders,
  createMockTask,
  mockApi,
  type MockApiState
} from "./mock-api.js";
import {
  mockDayPlanBlock,
  mockDayPlanTask,
  registerMockDayPlanRoutes
} from "./mock-day-plan-api.js";
import { seedTodayChrome } from "./today-page-chrome.js";

const NOW = "2026-09-10T16:00:00.000Z";
const DAY = "2026-09-10";
const LONG_PROSE =
  "Protect the launch window and reply to Alex about the contract deadline. " +
  "The morning review covers the deployment checklist, the vendor statement of work, " +
  "and the on-call handoff notes from yesterday evening. ".repeat(12);
const LONG_SOURCE = "extraordinarily-long-source-name-that-must-wrap-and-never-push-sideways";

test("proposed-read footer keeps Back to Today clear of the accept status at 375px", async ({
  page
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 375, height: 900 });

  const morningDefinition = createMockBriefingDefinition("briefing-proposed", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("morning-run-proposed", morningDefinition.id, LONG_PROSE, {
    briefingType: "morning",
    createdAt: NOW,
    sourceMetadata: {
      sourceTimestamps: {
        version: 1,
        capturedAt: NOW,
        sources: [{ source: LONG_SOURCE, freshnessKind: "connector_sync", asOf: NOW }]
      }
    },
    structuredPayload: { version: 1, actionRows: [], catchUp: null }
  });
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
    tasks: [createMockTask("t1", "Write the launch brief")],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition],
    briefingRuns: { [morningDefinition.id]: [run] },
    calendarEvents: []
  };
  await mockApi(page, state);
  await seedTodayChrome(page, DAY, "med-proposed");
  await registerMockDayPlanRoutes(page, {
    plan: {
      id: "plan-proposed",
      localDay: DAY,
      timeZone: "UTC",
      revision: 1,
      sourceRunId: null,
      eveningIntent: null,
      // No block has an actualPlacement, so the reader reports the
      // proposed-read surface (morning-briefing.tsx's hasAutomaticPlacement).
      blocks: [
        mockDayPlanBlock("b1", "t1", 0, {
          pendingChange: { kind: "add", startsAt: `${DAY}T10:00:00.000Z`, durationMinutes: 30 }
        })
      ]
    },
    tasks: [mockDayPlanTask("t1", "Write the launch brief")],
    fixedEvents: []
  });
  // The accept button's own success message appears from local state as soon as the
  // save call returns, but the app's day-plan refetch (which is what actually flips
  // the reader from "proposed" to "automatic") is a separate request that is not
  // awaited before that message shows. Real users see the accept message and the
  // still-"proposed" footer at the same time for that gap. A live day plan answers
  // in well under 500ms, so delaying only the day-plan read (not the write) recreates
  // that gap on a mocked page instead of it disappearing into an unrealistically
  // fast round trip.
  await page.route("**/api/calendar/day-plan*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return route.fallback();
  });

  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  // Every widget the page shows is populated, otherwise the gate proves nothing.
  await expect(page.locator(".today-hero .wx-now").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Log medication" }).first()).toBeVisible();
  await expect(page.getByText("Write the launch brief").first()).toBeVisible();

  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Protect the launch window");
  const footerNames = await dialog.locator(".brief-reader__footer button").allTextContents();
  expect(footerNames).toEqual([
    "Review proposed blocks",
    "Accept all time blocks",
    "Back to Today"
  ]);

  // Accepting shows the status line in the same footer, at the width where
  // Back to Today and the accept status previously shared a row and overlapped.
  await dialog.getByRole("button", { name: "Accept all time blocks" }).click();
  await expect(dialog).toContainText("Added 1 to the calendar");
  // The success message reads from local state before the day-plan refetch above
  // resolves, so the reader is still reporting the proposed surface right here.
  await expect(page.locator('[data-briefing-surface="proposed-read"]')).toHaveCount(1);

  const status = dialog.locator(".brief-reader__accept-status");
  const statusBox = await status.boundingBox();
  const back = dialog.getByRole("button", { name: "Back to Today" });
  const backBox = await back.boundingBox();
  const actions = dialog.locator(".brief-reader__footer-actions");
  const actionsBox = await actions.boundingBox();
  expect(statusBox, "accept status visible at 375px").not.toBeNull();
  expect(backBox, "Back to Today visible at 375px").not.toBeNull();
  expect(actionsBox, "footer actions visible at 375px").not.toBeNull();
  // Back to Today reads below the status line and above the link/primary row.
  expect(backBox!.y).toBeGreaterThanOrEqual(statusBox!.y + statusBox!.height);
  expect(actionsBox!.y).toBeGreaterThanOrEqual(backBox!.y + backBox!.height);
});
