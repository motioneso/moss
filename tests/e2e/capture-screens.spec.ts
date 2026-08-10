/**
 * One-off DESIGN-REVIEW screenshot capture. NOT part of the regular suite — run explicitly:
 *   pnpm --filter @moss/web exec playwright test tests/e2e/capture-screens.spec.ts
 * Dumps full-page PNGs of every major surface into ~/jarvis-design-review/screens/
 * so design-review agents can ground "AI-interface tells" findings on rendered pixels + code.
 */
import { test, type Page } from "@playwright/test";

import {
  createMockConnectorAccount,
  createMockConnectorProviders,
  createMockNotification,
  createMockTask,
  mockApi
} from "./mock-api.js";
import { createMockAiModel, createMockAiProvider } from "./mock-ai-api.js";
import { defaultOnboardingStatus } from "./mock-onboarding-api.js";
import {
  registerMockSportsRoutes,
  sportsOverviewDegradedFixture,
  sportsOverviewFixture
} from "./mock-sports-api.js";

// Output dir is gitignored (under test-results/) and overridable via SCREENS_DIR.
const OUT = process.env.SCREENS_DIR ?? "test-results/design-screens";

const richTasks = [
  createMockTask("task-1", "Renew passport before the Lisbon trip", {
    priority: 1,
    dueAt: "2026-07-01T00:00:00.000Z"
  }),
  createMockTask("task-2", "Review Q3 wellness rollout plan"),
  createMockTask("task-3", "Reply to landlord about lease renewal"),
  createMockTask("task-4", "Book dentist appointment", { status: "done" }),
  createMockTask("task-5", "Draft birthday message for Mom", { priority: 3 })
];

const richNotifications = [
  createMockNotification("n-1", "Your morning briefing is ready"),
  createMockNotification("n-2", "Calendar sync completed — 3 events added"),
  createMockNotification("n-3", "Lease renewal task is due tomorrow")
];

async function baseState(page: Page, overrides = {}) {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [
      createMockConnectorAccount("connector-1", {
        providerId: "google-email",
        providerDisplayName: "Google Email",
        scopes: ["gmail.readonly"],
        status: "active"
      }),
      createMockConnectorAccount("connector-2", {
        providerId: "google-calendar",
        providerDisplayName: "Google Calendar",
        scopes: ["calendar.readonly"],
        status: "active"
      })
    ],
    connectorProviders: createMockConnectorProviders(),
    notifications: richNotifications,
    tasks: richTasks,
    aiProviders: [
      createMockAiProvider("prov-1", { providerKind: "anthropic", displayName: "Anthropic" })
    ],
    aiModels: [
      createMockAiModel("model-1", {
        providerConfigId: "prov-1",
        providerKind: "anthropic",
        providerDisplayName: "Anthropic",
        providerModelId: "claude-opus-4-8",
        displayName: "Opus 4.8"
      })
    ],
    ...overrides
  });
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450); // let fonts/animations settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test.use({ viewport: { width: 1440, height: 900 } });

// On-demand design-regression harness — skipped in the normal suite/CI. Run with:
//   pnpm capture:screens   (sets CAPTURE=1)
test.beforeEach(() => {
  test.skip(
    process.env.CAPTURE !== "1",
    "Design screenshot-capture harness — run on demand via `pnpm capture:screens`."
  );
});

test("capture: sign-in", async ({ page }) => {
  await mockApi(page, {
    authenticated: false,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.goto("/");
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await shot(page, "01-signin");
});

test("capture: onboarding wizard", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    onboardingStatus: defaultOnboardingStatus({ state: "pending" })
  });
  await page.goto("/");
  await page.waitForTimeout(800);
  await shot(page, "02-onboarding");

  // Founder order is welcome -> cliAuth -> connectors -> finish; continueStep() advances
  // unconditionally, so no auth or mocked completion is needed to walk the wizard forward.
  await page.getByRole("button", { name: "Start setup" }).click();
  await page.getByRole("heading", { name: "Connect your AI provider." }).waitFor();
  await shot(page, "02b-onboarding-cliauth");

  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect to email and calendar" }).waitFor();
  await shot(page, "02c-onboarding-connectors");
});

test("capture: today + chat drawer", async ({ page }) => {
  await baseState(page);

  // Chat drawer conversation shot: the SSE stream is the source of truth for rendered
  // records (see chat-drawer.spec.ts), not the POST /api/chat/turn response body. Serve
  // the user+assistant events once on connect, then hold the reconnect open with no data
  // so events don't replay.
  let chatStreamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (chatStreamServed) {
      return;
    }
    chatStreamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body:
        'data: {"kind":"user","text":"What\'s on my calendar today?"}\n\n' +
        'data: {"kind":"reply","text":"You have a 10am sync with product and a 2pm dentist appointment."}\n\n'
    });
  });
  await page.route("**/api/chat/turn", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "You have a 10am sync with product and a 2pm dentist appointment."
      })
    })
  );

  await page.goto("/today");
  await page.waitForTimeout(600);
  await shot(page, "03-today");

  // user menu open
  const userMenu = page.getByRole("button", { name: /Owner User/ });
  if (await userMenu.count()) {
    await userMenu.click();
    await shot(page, "04-today-usermenu");
    await page.keyboard.press("Escape");
  }

  // chat drawer — unconditional: a missing button fails the capture instead of silently
  // skipping it (D6 item 5).
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  await page.waitForTimeout(600);
  await shot(page, "05-chat-drawer");

  // conversation shot: composer + message-row in both roles. Neither had capture
  // coverage before this (D6 item 5) — composer.tsx (527) + message-row.tsx (357) are
  // ~40% of the section.
  await page.getByLabel("Message Moss").fill("What's on my calendar today?");
  await page.getByLabel("Message Moss").press("Enter");
  await page.waitForTimeout(700);
  await shot(page, "05b-chat-conversation");
});

test("capture: tasks", async ({ page }) => {
  await baseState(page);
  await page.goto("/tasks");
  await page.waitForTimeout(600);
  await shot(page, "06-tasks-list");

  // try a matrix/eisenhower toggle if present
  const matrix = page.getByRole("button", { name: /Matrix|Priority|Eisenhower/i });
  if (await matrix.count()) {
    await matrix.first().click();
    await page.waitForTimeout(500);
    await shot(page, "07-tasks-matrix");
  }

  // open first task detail
  await page.goto("/tasks");
  await page.waitForTimeout(400);
  const firstTask = page.getByText("Renew passport before the Lisbon trip");
  if (await firstTask.count()) {
    await firstTask.first().click();
    await page.waitForTimeout(500);
    await shot(page, "08-task-detail");
  }
});

test("capture: tasks empty", async ({ page }) => {
  await baseState(page, { tasks: [] });
  await page.goto("/tasks");
  await page.waitForTimeout(600);
  await shot(page, "06b-tasks-empty");
});

test("capture: calendar", async ({ page }) => {
  await baseState(page);
  await page.goto("/calendar");
  await page.waitForTimeout(600);
  await shot(page, "09-calendar");
});

test("capture: notifications", async ({ page }) => {
  await baseState(page);
  await page.goto("/notifications");
  await page.waitForTimeout(500);
  await shot(page, "10-notifications");
});

test("capture: notifications empty", async ({ page }) => {
  await baseState(page, { notifications: [] });
  await page.goto("/notifications");
  await page.waitForTimeout(500);
  await shot(page, "10c-notifications-empty");
});

// #1390: command palette had no capture coverage — added ahead of the Today section migration
// so the pixel-diff can prove that migration a visual no-op like the calendar pilot.
test("capture: command palette", async ({ page }) => {
  await baseState(page);
  await page.goto("/today");
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await shot(page, "10a-command-palette");

  await page.keyboard.type("task");
  await page.waitForTimeout(300);
  await shot(page, "10b-command-palette-search");
});

test("capture: settings (profile, connected accounts, AI)", async ({ page }) => {
  await baseState(page);
  await page.goto("/settings");
  await page.waitForTimeout(500);
  await shot(page, "11-settings-profile");

  const connected = page.getByRole("button", { name: "Connected accounts" });
  if (await connected.count()) {
    await connected.click();
    await page.waitForTimeout(400);
    await shot(page, "12-settings-connected");
  }

  const admin = page.getByRole("button", { name: "Admin / Setup" });
  if (await admin.count()) {
    await admin.click();
    await page.waitForTimeout(300);
    const ai = page.getByRole("button", { name: "Assistant & AI" });
    if (await ai.count()) {
      await ai.click();
      await page.waitForTimeout(500);
      await shot(page, "13-settings-ai");
    }
    const people = page.getByRole("button", { name: /People & access/ });
    if (await people.count()) {
      await people.click();
      await page.waitForTimeout(400);
      await shot(page, "14-settings-people");
    }
  }
});

test("capture: settings appearance theme editor", async ({ page }) => {
  await baseState(page);
  await page.goto("/settings");
  await page.waitForTimeout(500);

  const appearance = page.getByRole("button", { name: "Appearance" });
  await appearance.click();
  await page.waitForTimeout(400);

  const newTheme = page.getByRole("button", { name: "New theme" });
  await newTheme.click();
  await page.waitForTimeout(400);
  await shot(page, "14b-settings-appearance-editor");
});

test("capture: settings delete-account dialog", async ({ page }) => {
  await baseState(page);
  await page.goto("/settings");
  await page.waitForTimeout(500);

  const deleteAccount = page.getByRole("button", { name: "Delete account" });
  await deleteAccount.click();
  await page.waitForTimeout(400);
  await shot(page, "14c-settings-delete-dialog");

  const cancel = page.getByRole("button", { name: "Cancel" });
  if (await cancel.count()) {
    await cancel.click();
  }
});

// #1392: wellness fixtures. Shapes match packages/shared/src/wellness-api.ts DTOs exactly —
// tone is "pine" | "amber" | "steel" (there is no "forest").
function wellnessCheckins() {
  const cores = [
    "happy",
    "sad",
    "fear",
    "anger",
    "happy",
    "surprise",
    "sad",
    "happy",
    "anger",
    "fear"
  ];
  return {
    checkins: cores.map((core, i) => ({
      id: `chk-${i}`,
      ownerUserId: "owner-user",
      checkedInAt: new Date(Date.UTC(2026, 6, 30 - i, 9, 0)).toISOString(),
      feelingCore: core,
      feelingSecondary: null,
      feelingTertiary: null,
      wheelVersion: "v2",
      sensations: [],
      intensity: 3,
      energy: 3,
      note: i === 0 ? "Slept well, feeling steady." : null,
      identifiedVia: "wheel",
      createdAt: new Date(Date.UTC(2026, 6, 30 - i, 9, 0)).toISOString()
    }))
  };
}

function wellnessMedications() {
  return {
    medications: [
      {
        id: "med-1",
        ownerUserId: "owner-user",
        name: "Sertraline",
        dosage: "50mg",
        form: "tablet",
        frequencyType: "once_daily",
        timesPerDay: null,
        intervalHours: null,
        weekdays: null,
        scheduleTimes: ["09:00"],
        cycleDaysOn: null,
        cycleDaysOff: null,
        cycleAnchorDate: null,
        active: true,
        notes: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "med-2",
        ownerUserId: "owner-user",
        name: "Melatonin",
        dosage: "3mg",
        form: "tablet",
        frequencyType: "as_needed",
        timesPerDay: null,
        intervalHours: null,
        weekdays: null,
        scheduleTimes: null,
        cycleDaysOn: null,
        cycleDaysOff: null,
        cycleAnchorDate: null,
        active: true,
        notes: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    ]
  };
}

function wellnessSchedule(date: string) {
  return {
    date,
    slots: [
      {
        medicationId: "med-1",
        name: "Sertraline",
        scheduledFor: `${date}T09:00:00.000Z`,
        asNeeded: false,
        status: "taken"
      },
      {
        medicationId: "med-2",
        name: "Melatonin",
        scheduledFor: null,
        asNeeded: true,
        status: "pending",
        prnCount: 0
      }
    ]
  };
}

function wellnessLogs() {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 6, 30 - i)).toISOString().slice(0, 10);
    return {
      date,
      scheduledCount: 1,
      takenCount: i === 2 ? 0 : 1,
      doses: [
        {
          medicationId: "med-1",
          name: "Sertraline",
          status: i === 2 ? "skipped" : "taken",
          prn: false
        }
      ]
    };
  });
  return { days };
}

function wellnessInsights() {
  return {
    insights: [
      {
        key: "streak",
        icon: "flame",
        tone: "pine",
        lead: "5-day check-in streak",
        rest: "You've checked in every day this week.",
        emotion: "happy"
      },
      {
        key: "adherence",
        icon: "pill",
        tone: "amber",
        lead: "One missed dose this week",
        rest: "Sertraline was skipped on Tuesday.",
        action: "Review schedule"
      },
      {
        key: "pattern",
        icon: "moon",
        tone: "steel",
        lead: "Evenings trend lower energy",
        rest: "Energy scores dip after 7pm on most days."
      }
    ]
  };
}

function wellnessTherapyNotes() {
  return {
    notes: [
      {
        id: "note-1",
        ownerUserId: "owner-user",
        body: "Discussed sleep routine changes and their effect on mood stability.",
        linkedCheckinId: null,
        linkedEmotion: "happy",
        createdAt: "2026-07-28T15:00:00.000Z",
        updatedAt: "2026-07-28T15:00:00.000Z"
      }
    ]
  };
}

test("capture: wellness", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await page.route("**/api/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modules: [
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            navigation: [
              {
                id: "wellness",
                label: "Wellness",
                path: "/wellness",
                icon: "heart-pulse",
                order: 40
              }
            ],
            settings: []
          }
        ]
      })
    })
  );
  // app.tsx's myModulesEnabled() gate (per-actor, independent of the nav-display /api/modules
  // mock above) fails closed to "denied" without this — see registerMockSportsRoutes() in
  // mock-sports-api.ts for the precedent.
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modules: [
          {
            id: "wellness",
            name: "Wellness",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true
          }
        ]
      })
    })
  );
  await page.route("**/api/wellness/checkins*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessCheckins())
    })
  );
  await page.route("**/api/wellness/medications/schedule*", (route) => {
    const url = new URL(route.request().url());
    const date = url.searchParams.get("date") ?? "2026-07-30";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessSchedule(date))
    });
  });
  await page.route("**/api/wellness/medications/logs*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessLogs())
    })
  );
  await page.route("**/api/wellness/medications", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessMedications())
    })
  );
  await page.route("**/api/wellness/insights", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessInsights())
    })
  );
  await page.route("**/api/wellness/therapy-notes", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(wellnessTherapyNotes())
    })
  );

  await page.goto("/wellness");
  await page.waitForTimeout(700);
  await shot(page, "15-wellness");

  // Wellness modals (checkin/manage-meds/export) close on a scrim click or the "Close" (x) button,
  // not Escape — there is no keydown handler, so Escape leaves the scrim intercepting the next click.
  const manage = page.getByRole("button", { name: "Manage" });
  if (await manage.count()) {
    await manage.first().click();
    await page.waitForTimeout(400);
    await shot(page, "15b-wellness-meds");
    await page.getByRole("button", { name: "Close" }).first().click();
    await page.waitForTimeout(200);
  }

  const exportBtn = page.getByRole("button", { name: "Export" });
  if (await exportBtn.count()) {
    await exportBtn.first().click();
    await page.waitForTimeout(400);
    await shot(page, "15c-wellness-export");
    await page.getByRole("button", { name: "Close" }).first().click();
    await page.waitForTimeout(200);
  }

  const checkin = page.getByRole("button", { name: "Start check-in" });
  if (await checkin.count()) {
    await checkin.click();
    await page.waitForTimeout(500);
    await shot(page, "16-wellness-checkin");
  }
});

test("capture: mobile today", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await baseState(page);
  await page.goto("/today");
  await page.waitForTimeout(600);
  await shot(page, "17-mobile-today");
});

// Broadsheet skin verification (#829 Task 5): ticker hairlines + overflow fade, edge-to-edge
// hero, hairline grid with followed-game field highlight — see docs/superpowers/specs for §5/§6.
test("capture: sports", async ({ page }) => {
  await baseState(page);
  await registerMockSportsRoutes(page);
  await page.goto("/sports");
  await page.waitForTimeout(600);
  await shot(page, "18-sports");
});

test("capture: sports mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await baseState(page);
  await registerMockSportsRoutes(page);
  await page.goto("/sports");
  await page.waitForTimeout(600);
  await shot(page, "19-sports-mobile");
});

// Reduced-motion pass: skeleton (delayed response) then the settled hero, both captured with
// prefers-reduced-motion: reduce emulated so the live dot / skeleton shimmer must be static.
test("capture: sports reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await baseState(page);
  await registerMockSportsRoutes(page); // sports module gate + overview route
  // Override the overview route again (most-recently-registered wins) with a delayed response
  // so the initial screenshot lands on the skeleton, not the settled hero.
  await page.route("**/api/sports/overview", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sportsOverviewFixture)
    });
  });
  await page.goto("/sports");
  await page.waitForTimeout(300);
  await shot(page, "20-sports-reduced-motion-skeleton");
  await page.waitForTimeout(1600);
  await shot(page, "21-sports-reduced-motion");
});

// Partial-provider-outage pass: DegradedBand notice must render above the (still-populated)
// sections, not replace them (#765 M1).
test("capture: sports degraded", async ({ page }) => {
  await baseState(page);
  await registerMockSportsRoutes(page, sportsOverviewDegradedFixture);
  await page.goto("/sports");
  await page.waitForTimeout(600);
  await shot(page, "22-sports-degraded");
});
