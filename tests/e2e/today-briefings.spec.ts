import { expect, test } from "@playwright/test";

import {
  createMockBriefingDefinition,
  createMockBriefingRun,
  createMockConnectorProviders,
  createMockTask,
  mockApi,
  type MockApiState
} from "./mock-api.js";
import { myModulesResponse } from "./mock-modules.js";

const NOW = "2026-09-10T16:00:00.000Z";
const DAY = "2026-09-10";
const LONG_PROSE =
  "Protect the launch window and reply to Alex about the contract deadline. " +
  "The morning review covers the deployment checklist, the vendor statement of work, " +
  "and the on-call handoff notes from yesterday evening. ".repeat(12);
const LONG_SOURCE = "extraordinarily-long-source-name-that-must-wrap-and-never-push-sideways";

test("morning briefing reader opens, stays in viewport, and returns focus", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));

  const morningDefinition = createMockBriefingDefinition("briefing-morning", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("morning-run-1", morningDefinition.id, LONG_PROSE, {
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
    tasks: [createMockTask("task-reader", "Write the launch brief")],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition],
    briefingRuns: { [morningDefinition.id]: [run] },
    calendarEvents: [0, 1].map((i) => ({
      id: `reader-event-${i}`,
      connectorAccountId: "account-1",
      ownerUserId: "user-1",
      title: "Team sync with a fairly long meeting title",
      startsAt: `2026-09-10T${15 + i}:00:00.000Z`,
      endsAt: `2026-09-10T${16 + i}:00:00.000Z`,
      location: "Conference Room B",
      summary: null,
      bodyExcerpt: null,
      externalId: `ext-reader-${i}`,
      isMossBlock: false,
      allDay: false,
      attendeeCount: 3,
      status: null,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z"
    }))
  };
  await mockApi(page, state);
  // Wellness enabled with one scheduled medication for the day.
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modules: [
          ...myModulesResponse.modules,
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: false,
            hasUserCredentials: false,
            scope: "everyone"
          }
        ]
      })
    })
  );
  await page.route("**/api/wellness/medications/schedule*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        date: DAY,
        slots: [
          {
            medicationId: "med-reader",
            name: "Morning Vitamin",
            scheduledFor: `${DAY}T08:00:00.000Z`,
            asNeeded: false,
            status: "pending"
          }
        ]
      })
    })
  );
  // Populated weather strip.
  await page.route("**/api/weather/today", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          temp: 72,
          feelsLike: 71,
          condition: "Sunny",
          icon: "sun",
          location: "San Francisco, CA",
          unit: "imperial",
          humidity: 55,
          dewPoint: 54,
          windSpeed: 5,
          lat: 37.7,
          lon: -122.4,
          forecast: [0, 1, 2].map((offset) => ({
            date: `2026-09-${String(10 + offset).padStart(2, "0")}`,
            icon: "sun",
            high: 75 - offset,
            low: 60 - offset
          }))
        }
      })
    })
  );
  // Saved day plan with blocks plus the one task above.
  await page.route("**/api/calendar/day-plan*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plan: {
          id: "plan-reader",
          localDay: DAY,
          timeZone: "UTC",
          revision: 1,
          sourceRunId: null,
          blocks: [
            {
              id: "b1",
              kind: "focus",
              taskId: "task-reader",
              title: null,
              position: 0,
              actualPlacement: {
                startsAt: `${DAY}T14:00:00.000Z`,
                durationMinutes: 90,
                calendarEventRef: null
              },
              pendingChange: null
            }
          ],
          eveningIntent: {
            priorityTaskIds: [],
            capacity: null,
            notes: null,
            corrections: [],
            commitments: []
          }
        },
        tasks: [
          {
            id: "task-reader",
            title: "Write the launch brief",
            status: "todo",
            dueAt: null,
            doAt: null,
            effort: null
          }
        ],
        unavailableTaskIds: [],
        sourceRun: null,
        sourceRunUnavailable: false
      })
    })
  );

  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/today");
    await expect(page.locator(".cmd-wrap")).toBeVisible();
    // Every widget the page shows is populated, otherwise the width check proves nothing.
    await expect(page.locator(".jds-weather-chip__day").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Meds/ }).first()).toBeVisible();
    await expect(page.getByText("Write the launch brief").first()).toBeVisible();
    await page.getByRole("button", { name: "Read the full morning briefing" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "Morning briefing" })).toBeFocused();
    await expect(dialog).toContainText("Protect the launch window");
    await expect(dialog).toContainText(LONG_SOURCE);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no sideways scroll at ${width}px`
    ).toBe(true);

    const back = page.getByRole("button", { name: "Back to Today" });
    const box = await back.boundingBox();
    expect(box, `footer inside the viewport at ${width}px`).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(901);

    await back.click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Read the full morning briefing" })
    ).toBeFocused();
  }

  // Desktop shows the schedule open beside the report, and opening a schedule
  // task closes the reader first so the task dialog can take focus.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const desktopDialog = page.getByRole("dialog");
  await expect(desktopDialog).toBeVisible();
  await expect(desktopDialog).toContainText("Write the launch brief");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 1440px"
  ).toBe(true);
  await desktopDialog
    .getByRole("button", { name: /Write the launch brief/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Morning briefing" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
});
