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

import { mockCalEvent, seedTodayChrome } from "./today-page-chrome.js";

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
  await seedTodayChrome(page, DAY, "med-reader");
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

test("day plan review applies adds and a confirmed move from Today and the reader", async ({
  page
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 1440, height: 900 });

  const morningDefinition = createMockBriefingDefinition("briefing-review", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("morning-run-review", morningDefinition.id, LONG_PROSE, {
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
  const lunch = {
    id: "review-event-lunch",
    connectorAccountId: "account-1",
    ownerUserId: "user-1",
    title: "Lunch with Sam",
    startsAt: `${DAY}T12:00:00.000Z`,
    endsAt: `${DAY}T13:00:00.000Z`,
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "ext-review-lunch",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z"
  };
  const dentist = {
    ...lunch,
    id: "review-event-dentist",
    title: "Dentist appointment",
    startsAt: `${DAY}T18:30:00.000Z`,
    endsAt: `${DAY}T19:00:00.000Z`,
    externalId: "ext-review-dentist"
  };
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
    tasks: [
      createMockTask("t1", "Write the launch brief"),
      createMockTask("t2", "Call the vendor"),
      createMockTask("t3", "Ship the invoice"),
      createMockTask("t4", "Water the plants"),
      createMockTask("t5", "File the report", { dueAt: "2026-09-12T00:00:00.000Z" }),
      createMockTask("t6", "Review the contract")
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition],
    briefingRuns: { [morningDefinition.id]: [run] },
    calendarEvents: [lunch, dentist]
  };
  await mockApi(page, state);
  await seedTodayChrome(page, DAY, "med-review");
  await registerMockDayPlanRoutes(page, {
    plan: {
      id: "plan-review",
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
      blocks: [
        mockDayPlanBlock("b1", "t1", 0, {
          pendingChange: { kind: "add", startsAt: `${DAY}T10:00:00.000Z`, durationMinutes: 30 }
        }),
        mockDayPlanBlock("b2", "t2", 1, {
          pendingChange: { kind: "add", startsAt: `${DAY}T12:00:00.000Z`, durationMinutes: 30 }
        }),
        mockDayPlanBlock("b3", "t3", 2, {
          actualPlacement: {
            startsAt: `${DAY}T14:00:00.000Z`,
            durationMinutes: 60,
            calendarEventRef: "ev-cal-3"
          }
        }),
        mockDayPlanBlock("b4", "t4", 3, {
          actualPlacement: {
            startsAt: `${DAY}T16:00:00.000Z`,
            durationMinutes: 30,
            calendarEventRef: "ev-cal-4"
          }
        }),
        mockDayPlanBlock("b5", "t5", 4),
        mockDayPlanBlock("b6", "t6", 5, {
          actualPlacement: {
            startsAt: `${DAY}T09:00:00.000Z`,
            durationMinutes: 30,
            calendarEventRef: "ev-cal-6"
          },
          pendingChange: { kind: "move", startsAt: `${DAY}T15:00:00.000Z`, durationMinutes: 30 }
        })
      ]
    },
    tasks: [
      mockDayPlanTask("t1", "Write the launch brief"),
      mockDayPlanTask("t2", "Call the vendor"),
      mockDayPlanTask("t3", "Ship the invoice"),
      mockDayPlanTask("t4", "Water the plants"),
      mockDayPlanTask("t5", "File the report", "2026-09-12T00:00:00.000Z"),
      mockDayPlanTask("t6", "Review the contract")
    ],
    fixedEvents: [lunch]
  });

  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  // Every widget the page shows is populated, otherwise the gate proves nothing.
  await expect(page.locator(".jds-weather-chip__day").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Meds/ }).first()).toBeVisible();
  await expect(page.getByText("Write the launch brief").first()).toBeVisible();
  await expect(page.getByText("Lunch with Sam").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Review task blocks" }).first()).toBeVisible();

  // Open from Today: focus lands on the title and rows read schedule words.
  await page.getByRole("button", { name: "Review task blocks" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeFocused();
  await expect(dialog).toContainText("Proposed, not on the calendar yet");

  // Leave the due-dated block unscheduled: the consequence reads in words.
  await dialog.getByLabel("File the report: placement").selectOption("leave");
  await expect(dialog).toContainText("Due Sep 12, no time set");

  // Choose both proposals so they join the selection; the summary names each.
  await dialog.getByLabel("Write the launch brief: placement").selectOption("add");
  await dialog.getByLabel("Write the launch brief: start time").fill("10:30");
  await dialog.getByLabel("Call the vendor: placement").selectOption("add");
  await dialog.getByLabel("Call the vendor: start time").fill("12:30");
  await expect(dialog).toContainText("Add Write the launch brief at 10:30");
  await expect(dialog).toContainText("Add Call the vendor at 12:30");

  // Preview: the lunch overlap names the commitment; only the clean add applies.
  await dialog.getByRole("button", { name: "Preview changes" }).click();
  await expect(dialog).toContainText("Overlaps Lunch with Sam, 12:00 to 1:00");
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(dialog).toContainText("Applied 1; 0 failed; 0 pending.");
  await expect(dialog).not.toContainText("Confirm calendar changes");

  // Back on Today the added block reads on the calendar without a reload.
  await dialog.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeHidden();
  await page.getByRole("button", { name: "Review task blocks" }).first().click();
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeVisible();
  await expect(dialog).toContainText("On the calendar");
  // The task dialog still opens for the added block.
  await dialog
    .getByRole("button", { name: /Write the launch brief/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Move the calendar block: confirmation names the event and keeps the task.
  await page.getByRole("button", { name: "Review task blocks" }).first().click();
  await dialog.getByLabel("Ship the invoice: placement").selectOption("move");
  await dialog.getByLabel("Ship the invoice: start time").fill("17:00");
  await dialog.getByRole("button", { name: "Preview changes" }).click();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  const confirm = dialog.locator("section.plan-review__confirm");
  await expect(confirm).toContainText("Confirm calendar changes");
  await expect(confirm).toContainText("Ship the invoice");
  await expect(confirm).toContainText("tasks themselves remain");
  // Keep reviewing changes nothing: no outcomes appear.
  await confirm.getByRole("button", { name: "Keep reviewing" }).click();
  await expect(confirm).toBeHidden();
  // The earlier outcome stands unchanged: nothing new applied.
  await expect(dialog).toContainText("Applied 1; 0 failed; 0 pending.");
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toContainText("Applied 2; 0 failed; 0 pending.");
  await dialog.getByRole("button", { name: "Back to Today" }).click();
  await expect(page.locator("#schedule")).toContainText("5:00");

  // Open from the reader footer: the review replaces the reader, so one
  // dialog owns the page and Escape lands back on Today.
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const reader = page.getByRole("dialog");
  await expect(reader).toContainText("Protect the launch window");
  await reader.getByRole("button", { name: "Review task blocks" }).click();
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Morning briefing" })).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Read the full morning briefing" })).toBeFocused();

  // Widths on the populated page: no sideways scroll, footer stays visible.
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Review task blocks" }).first().click();
    await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no sideways scroll at ${width}px`
    ).toBe(true);
    const back = page.getByRole("dialog").getByRole("button", { name: "Back to Today" });
    const box = await back.boundingBox();
    expect(box, `footer inside the viewport at ${width}px`).not.toBeNull();
    await back.click();
  }
});
test("accept all applies eligible additions from the reader, then reviews the conflict", async ({
  page
}) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 320, height: 900 });

  const morningDefinition = createMockBriefingDefinition("briefing-accept", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const run = createMockBriefingRun("morning-run-accept", morningDefinition.id, LONG_PROSE, {
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
  const standup = {
    id: "accept-event-standup",
    connectorAccountId: "account-1",
    ownerUserId: "user-1",
    title: "Team standup",
    startsAt: `${DAY}T12:00:00.000Z`,
    endsAt: `${DAY}T12:30:00.000Z`,
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "ext-accept-standup",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 3,
    status: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z"
  };
  const lunch = {
    ...standup,
    id: "accept-event-lunch",
    title: "Lunch with Sam",
    startsAt: `${DAY}T15:30:00.000Z`,
    endsAt: `${DAY}T16:30:00.000Z`,
    externalId: "ext-accept-lunch"
  };
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
    tasks: [
      createMockTask("t1", "Write the launch brief"),
      createMockTask("t2", "Call the vendor"),
      createMockTask("t3", "Ship the invoice"),
      createMockTask("t4", "Water the plants"),
      createMockTask("t5", "File the report", { dueAt: "2026-09-12T00:00:00.000Z" }),
      createMockTask("t6", "Review the contract")
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition],
    briefingRuns: { [morningDefinition.id]: [run] },
    calendarEvents: [standup, lunch]
  };
  await mockApi(page, state);
  await seedTodayChrome(page, DAY, "med-accept");
  await registerMockDayPlanRoutes(page, {
    plan: {
      id: "plan-accept",
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
      blocks: [
        mockDayPlanBlock("b1", "t1", 0, {
          pendingChange: { kind: "add", startsAt: `${DAY}T10:00:00.000Z`, durationMinutes: 30 }
        }),
        mockDayPlanBlock("b2", "t2", 1, {
          pendingChange: { kind: "add", startsAt: `${DAY}T12:00:00.000Z`, durationMinutes: 30 }
        }),
        mockDayPlanBlock("b3", "t3", 2, {
          pendingChange: { kind: "add", startsAt: `${DAY}T15:00:00.000Z`, durationMinutes: 30 }
        }),
        mockDayPlanBlock("b4", "t4", 3, {
          actualPlacement: {
            startsAt: `${DAY}T14:00:00.000Z`,
            durationMinutes: 60,
            calendarEventRef: "ev-cal-4"
          }
        }),
        mockDayPlanBlock("b5", "t5", 4),
        mockDayPlanBlock("b6", "t6", 5, {
          actualPlacement: {
            startsAt: `${DAY}T09:00:00.000Z`,
            durationMinutes: 30,
            calendarEventRef: "ev-cal-6"
          }
        })
      ]
    },
    tasks: [
      mockDayPlanTask("t1", "Write the launch brief"),
      mockDayPlanTask("t2", "Call the vendor"),
      mockDayPlanTask("t3", "Ship the invoice"),
      mockDayPlanTask("t4", "Water the plants"),
      mockDayPlanTask("t5", "File the report", "2026-09-12T00:00:00.000Z"),
      mockDayPlanTask("t6", "Review the contract")
    ],
    fixedEvents: [standup]
  });

  // Request observers registered last so they see every call, then fall
  // through to the day-plan mock above.
  const previewed: { selectedChangeBlockIds: string[]; expectedRevision: number }[] = [];
  const applied: { selectedBlockIds: string[]; expectedRevision: number }[] = [];
  let confirms = 0;
  let retries = 0;
  await page.route("**/api/calendar/day-plans/*/preview", async (route) => {
    if (route.request().method() === "POST")
      previewed.push(route.request().postDataJSON() as never);
    await route.fallback();
  });
  await page.route("**/api/calendar/day-plans/*/apply", async (route) => {
    if (route.request().method() === "POST") applied.push(route.request().postDataJSON() as never);
    await route.fallback();
  });
  await page.route("**/api/calendar/day-plans/*/operations/*/confirm", async (route) => {
    if (route.request().method() === "POST") confirms += 1;
    await route.fallback();
  });
  await page.route("**/api/calendar/day-plans/*/operations/*/retry", async (route) => {
    if (route.request().method() === "POST") retries += 1;
    await route.fallback();
  });

  await page.goto("/today");
  await expect(page.locator(".cmd-wrap")).toBeVisible();
  // Every widget the page shows is populated, otherwise the gate proves nothing.
  await expect(page.locator(".jds-weather-chip__day").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Meds/ }).first()).toBeVisible();
  await expect(page.getByText("Write the launch brief").first()).toBeVisible();
  await expect(page.getByText("Team standup").first()).toBeVisible();
  await expect(page.getByText("Lunch with Sam").first()).toBeVisible();

  // The reader footer offers Accept all first on the populated 320px page.
  await page.getByRole("button", { name: "Read the full morning briefing" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Protect the launch window");
  const footerNames = await dialog.locator(".brief-reader__footer button").allTextContents();
  expect(footerNames).toEqual(["Accept all time blocks", "Review task blocks", "Back to Today"]);

  // One activation previews the three proposals and applies the two clean ones.
  await dialog.getByRole("button", { name: "Accept all time blocks" }).click();
  await expect(dialog).toContainText("Added 2 to the calendar");
  await expect(dialog.getByRole("button", { name: "Review changes" })).toBeVisible();
  expect(previewed).toHaveLength(1);
  expect(previewed[0]!.selectedChangeBlockIds).toEqual(["b1", "b2", "b3"]);
  expect(applied).toHaveLength(1);
  expect(applied[0]!.selectedBlockIds).toEqual(["b1", "b3"]);
  expect(applied[0]!.expectedRevision).toBe(previewed[0]!.expectedRevision);
  expect(confirms).toBe(0);

  // The reader stays open with its footer inside the narrow viewport.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 320px with the status line"
  ).toBe(true);
  const back = dialog.getByRole("button", { name: "Back to Today" });
  const backBox = await back.boundingBox();
  expect(backBox, "reader footer inside the 320px viewport").not.toBeNull();
  expect(backBox!.x + backBox!.width).toBeLessThanOrEqual(321);

  // Review changes keeps the rows, names the conflict and shows the outcomes.
  await dialog.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("heading", { name: "Review task blocks" })).toBeVisible();
  await expect(dialog).toContainText("Overlaps Team standup");
  await expect(dialog).toContainText("Applied 2; 0 failed; 0 pending.");
  // Everything resolved, so there is nothing to retry and no retry is sent.
  await expect(dialog.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(retries).toBe(0);

  // The review footer holds four buttons inside the narrow viewport.
  const reviewNames = await dialog.locator(".brief-reader__footer button").allTextContents();
  expect(reviewNames).toEqual([
    "Back to Today",
    "Preview changes",
    "Apply changes",
    "Accept all time blocks"
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no sideways scroll at 320px in the review"
  ).toBe(true);
  const reviewBackBox = await dialog.getByRole("button", { name: "Back to Today" }).boundingBox();
  expect(reviewBackBox, "review footer inside the 320px viewport").not.toBeNull();
  expect(reviewBackBox!.x + reviewBackBox!.width).toBeLessThanOrEqual(321);
});

test("evening planning saves one draft and never applies in suggest mode", async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize({ width: 1440, height: 900 });
  const TMO = "2026-09-11";

  const morningDefinition = createMockBriefingDefinition("briefing-evening-t20", "Morning", {
    briefingType: "morning",
    cadence: "daily",
    scheduleMetadata: { targetTime: "07:00", timezone: "UTC" }
  });
  const eveningDefinition = createMockBriefingDefinition("briefing-evening-run", "Evening", {
    briefingType: "evening",
    cadence: "daily",
    enabled: true,
    scheduleMetadata: { targetTime: "00:00", timezone: "UTC" }
  });
  const morningRun = createMockBriefingRun("morning-run-t20", morningDefinition.id, LONG_PROSE, {
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
  const eveningRun = createMockBriefingRun("evening-run-t20", eveningDefinition.id, LONG_PROSE, {
    briefingType: "evening",
    createdAt: NOW
  });
  const lunch = mockCalEvent(
    "evening-event-lunch",
    "Lunch with Sam",
    DAY + "T12:00:00.000Z",
    DAY + "T13:00:00.000Z"
  );
  const tmStandup = mockCalEvent(
    "evening-event-standup",
    "Team standup",
    TMO + "T09:00:00.000Z",
    TMO + "T10:00:00.000Z"
  );
  const tmDentist = mockCalEvent(
    "evening-event-dentist",
    "Dentist",
    TMO + "T16:00:00.000Z",
    TMO + "T16:30:00.000Z"
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
    tasks: [
      createMockTask("t1", "Write the launch brief"),
      createMockTask("t2", "Call the vendor"),
      createMockTask("t3", "Ship the invoice"),
      createMockTask("t4", "Water the plants"),
      createMockTask("t5", "File the report", { dueAt: TMO + "T12:00:00.000Z" }),
      createMockTask("t6", "Review the contract", { dueAt: DAY + "T12:00:00.000Z" }),
      createMockTask("t7", "Paid the rent", { status: "done", completedAt: DAY + "T10:00:00.000Z" })
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    briefingDefinitions: [morningDefinition, eveningDefinition],
    briefingRuns: { [morningDefinition.id]: [morningRun], [eveningDefinition.id]: [eveningRun] },
    calendarEvents: [lunch, tmStandup, tmDentist]
  };
  await mockApi(page, state);
  await seedTodayChrome(page, DAY, "med-evening");
  await registerMockDayPlanRoutes(page, {
    plan: {
      id: "plan-evening-today",
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
      blocks: [
        mockDayPlanBlock("t-b1", "t1", 0, {
          pendingChange: { kind: "add", startsAt: DAY + "T10:00:00.000Z", durationMinutes: 30 }
        }),
        mockDayPlanBlock("t-b2", "t2", 1, {
          pendingChange: { kind: "add", startsAt: DAY + "T12:00:00.000Z", durationMinutes: 30 }
        }),
        mockDayPlanBlock("t-b3", "t3", 2, {
          actualPlacement: {
            startsAt: DAY + "T14:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "ev-cal-3"
          }
        }),
        mockDayPlanBlock("t-b4", "t4", 3, {
          actualPlacement: {
            startsAt: DAY + "T16:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: "ev-cal-4"
          }
        }),
        mockDayPlanBlock("t-b5", "t5", 4),
        mockDayPlanBlock("t-b6", "t6", 5, {
          actualPlacement: {
            startsAt: DAY + "T09:00:00.000Z",
            durationMinutes: 30,
            calendarEventRef: "ev-cal-6"
          },
          pendingChange: { kind: "move", startsAt: DAY + "T15:00:00.000Z", durationMinutes: 30 }
        })
      ]
    },
    tomorrowPlan: {
      id: "plan-evening-tomorrow",
      localDay: TMO,
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
      blocks: [
        mockDayPlanBlock("tm-b1", "t3", 0, {
          actualPlacement: {
            startsAt: TMO + "T14:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "ev-tm-1"
          }
        }),
        mockDayPlanBlock("tm-b2", "t4", 1, {
          pendingChange: { kind: "add", startsAt: TMO + "T10:00:00.000Z", durationMinutes: 30 }
        }),
        mockDayPlanBlock("tm-b3", "t6", 2, {
          pendingChange: { kind: "add", startsAt: TMO + "T11:00:00.000Z", durationMinutes: 30 }
        })
      ]
    },
    tasks: [
      mockDayPlanTask("t1", "Write the launch brief"),
      mockDayPlanTask("t2", "Call the vendor"),
      mockDayPlanTask("t3", "Ship the invoice"),
      mockDayPlanTask("t4", "Water the plants"),
      mockDayPlanTask("t5", "File the report", TMO + "T12:00:00.000Z"),
      mockDayPlanTask("t6", "Review the contract")
    ],
    fixedEvents: [lunch]
  });

  const writes: { method: string; url: string }[] = [];
  page.on("request", (request) => {
    writes.push({ method: request.method(), url: request.url() });
  });

  await page.goto("/today");
  await expect(page.getByRole("button", { name: "Plan tomorrow" })).toBeVisible();
  await expect(page.locator(".jds-weather-chip__day").first()).toBeVisible();
  await expect(page.getByText("Write the launch brief").first()).toBeVisible();
  await expect(page.getByText("Lunch with Sam").first()).toBeVisible();
  await expect(page.getByText("Team standup").first()).toBeVisible();

  await page.getByRole("button", { name: "Plan tomorrow" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan tomorrow" })).toBeVisible();
  await expect(dialog).toContainText("Protect the launch window");

  // Correct a task: the note reads back, no task is completed.
  const correction = dialog.getByLabel("Write the launch brief: correction");
  await correction.fill("Scope slipped again");
  await correction.locator("xpath=ancestor::li[1]").getByRole("button", { name: "Add" }).click();
  await expect(dialog).toContainText("Noted: Scope slipped again");
  await expect(dialog).toContainText("Done");

  // Commit one task for tomorrow; the due-dated one is already set.
  await dialog
    .getByRole("radiogroup", { name: "Call the vendor: plan" })
    .getByLabel("Tomorrow")
    .click();
  await expect(
    dialog.getByRole("radiogroup", { name: "Call the vendor: plan" }).getByLabel("Tomorrow")
  ).toBeChecked();
  await expect(dialog).toContainText("Already set for tomorrow");

  // Lighter day with a main priority, then save in suggest mode.
  await dialog.getByRole("radiogroup", { name: "Day capacity" }).getByLabel("Lighter day").click();
  await dialog.getByLabel("Main priority").selectOption("t2");
  await dialog.getByRole("button", { name: "Save tomorrow's plan" }).click();
  await expect(dialog).toContainText("Saved. The blocks are proposed for the morning.");

  // Exactly one draft save; suggest mode never previews or applies.
  const drafts = writes.filter((entry) => entry.method === "PATCH" && entry.url.endsWith("/draft"));
  expect(drafts.length).toBe(1);
  expect(writes.filter((entry) => entry.url.endsWith("/preview")).length).toBe(0);
  expect(writes.filter((entry) => entry.url.endsWith("/apply")).length).toBe(0);

  // Widths on the populated page: no sideways scroll, footer stays visible.
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Plan tomorrow" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no sideways scroll at " + width + "px"
    ).toBe(true);
    const save = dialog.getByRole("button", { name: "Save tomorrow's plan" });
    const box = await save.boundingBox();
    expect(box, "footer inside the viewport at " + width + "px").not.toBeNull();
  }
});
