import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.js";

test.beforeEach(async ({ page }) => {
  // Reuse the repo's central auth/me/notifications mocks so /wellness renders past the auth gate.
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  // Override /api/modules so the Wellness nav entry exists (registered after mockApi → wins).
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

  // The shell also fetches /api/me/modules for active flags — keep wellness visible (active).
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

  // Medications list (Manage-meds modal) + add path.
  let createdMedication: Record<string, unknown> | null = null;
  await page.route("**/api/wellness/medications", (route) => {
    if (route.request().method() === "POST") {
      createdMedication = {
        id: "m-new",
        ownerUserId: "user-1",
        name: "New Med",
        dosage: null,
        form: null,
        frequencyType: "once_daily",
        timesPerDay: null,
        intervalHours: null,
        weekdays: null,
        scheduleTimes: ["08:00"],
        cycleDaysOn: null,
        cycleDaysOff: null,
        cycleAnchorDate: null,
        active: true,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          medication: {
            id: "m-new",
            ownerUserId: "user-1",
            name: "New Med",
            dosage: null,
            form: null,
            frequencyType: "once_daily",
            timesPerDay: null,
            intervalHours: null,
            weekdays: null,
            scheduleTimes: ["08:00"],
            cycleDaysOn: null,
            cycleDaysOff: null,
            cycleAnchorDate: null,
            active: true,
            notes: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ medications: createdMedication ? [createdMedication] : [] })
    });
  });

  // Today's medication schedule backs the MedToday card — keep empty so it renders the empty state.
  await page.route("**/api/wellness/medications/schedule**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ date: "2026-06-14", slots: [] })
    })
  );

  // Medication adherence summary (Trends chart) — one day with partial adherence.
  await page.route("**/api/wellness/medications/logs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        days: [
          {
            date: "2026-06-14",
            scheduledCount: 2,
            takenCount: 1,
            doses: [
              { medicationId: "m-1", name: "MedA", status: "taken", prn: false },
              { medicationId: "m-1", name: "MedA", status: "pending", prn: false }
            ]
          }
        ]
      })
    })
  );

  // Insights panel — return an empty insight set (renders the "keep checking in" line).
  await page.route("**/api/wellness/insights**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ insights: [] })
    })
  );

  // Therapy notes — empty list.
  await page.route("**/api/wellness/therapy-notes**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          note: {
            id: "tn-new",
            ownerUserId: "user-1",
            body: "A note",
            linkedCheckinId: null,
            linkedEmotion: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notes: [] })
    });
  });

  // Check-ins list (empty → today's check-in card shows the prompt) + create.
  await page.route("**/api/wellness/checkins**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          checkin: {
            id: "c1",
            ownerUserId: "user-1",
            checkedInAt: new Date().toISOString(),
            feelingCore: "happy",
            feelingSecondary: "Joy",
            feelingTertiary: null,
            wheelVersion: "jarvis-emotion-v1",
            sensations: [],
            intensity: 3,
            energy: null,
            note: null,
            identifiedVia: "wheel",
            createdAt: new Date().toISOString()
          }
        })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ checkins: [] })
    });
  });
});

test("wellness page renders the new screen and a guided check-in can be saved", async ({
  page
}) => {
  await page.goto("/wellness");
  // The new screen leads with the editorial hero title, not a generic "Wellness" heading.
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toBeVisible();

  // Open the check-in modal from the today card.
  await page.getByRole("button", { name: "Start check-in" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("How are you feeling right now?")).toBeVisible();

  // Guided picker step 1: pick a core emotion from the radial dial. Scope to the modal
  // so the emotion-strip buttons on the page behind it are excluded.
  await dialog.locator(".wl-dial__seg", { hasText: "Happy" }).click();

  // Step 2: pick a feeling word (Joy is a Happy feeling) from the feeling chips.
  await dialog.getByRole("button", { name: "Joy", exact: true }).click();

  // No "Next" step — detail fields appear inline once both emotion and feeling are set.
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/wellness/checkins") && r.method() === "POST"),
    dialog.getByRole("button", { name: "Save check-in" }).click()
  ]);
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body.feelingCore).toBe("happy");
  expect(body.feelingSecondary).toBe("Joy");
  expect(body.identifiedVia).toBe("wheel");
});

test("manage-meds modal can add a medication", async ({ page }) => {
  await page.goto("/wellness");
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toBeVisible();

  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Manage medications")).toBeVisible();

  await dialog.getByLabel("Medication name").fill("Bupropion");

  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/api/wellness/medications") && r.method() === "POST"
    ),
    dialog.getByRole("button", { name: "Add medication", exact: true }).click()
  ]);
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body.name).toBe("Bupropion");
  expect(body.frequencyType).toBe("once_daily");
  await expect(dialog.getByText("New Med")).toBeVisible();
});

test("a therapy note can be added", async ({ page }) => {
  await page.goto("/wellness");
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toBeVisible();

  await page.getByPlaceholder("Something to talk through…").fill("Ask about evening dread");

  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/api/wellness/therapy-notes") && r.method() === "POST"
    ),
    page.getByRole("button", { name: "Add", exact: true }).click()
  ]);
  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body.body).toBe("Ask about evening dread");
});

test("wellness nav is hidden when the actor has disabled the module", async ({ page }) => {
  // Override /api/me/modules so wellness is reported inactive for this actor.
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
            userDisabled: true,
            active: false
          }
        ]
      })
    })
  );

  await page.goto("/wellness");
  await expect(page.locator(".module-nav").getByRole("link", { name: "Wellness" })).toHaveCount(0);

  // Deep-linking the disabled health-data route must NOT render the wellness UI: the SPA
  // route is gated on the actor's module state and redirects to /tasks once it resolves.
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toHaveCount(0);
});

test("wellness route fails closed when the module-state request errors", async ({ page }) => {
  // If /api/me/modules cannot be read we cannot prove the actor is enabled, so the gate must
  // fail closed for a health-data module: redirect, never mount the wellness UI (Codex review).
  await page.route("**/api/me/modules", (route) => route.fulfill({ status: 500, body: "boom" }));

  await page.goto("/wellness");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toHaveCount(0);
});

test("trends chart renders using adherence summary shape (days[] not logs[])", async ({ page }) => {
  await page.goto("/wellness");
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toBeVisible();
  // The Trends section renders a chart card — assert the heading text is present.
  await expect(page.getByText("Mood & medication")).toBeVisible();
  // The chart SVG renders (no crash from mismatched shape).
  await expect(
    page.locator(".wl-chart__plot svg[aria-label='Mood trend with daily medication adherence']")
  ).toBeVisible();
});

test("wellness route fails closed when the module is absent from the state response", async ({
  page
}) => {
  // A 200 that omits wellness (backend skew / partial response) is NOT proof of enablement:
  // affirmative enablement is required, so the gate denies and never mounts the UI (Codex R3).
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ modules: [] })
    })
  );

  await page.goto("/wellness");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "How you're really doing." })).toHaveCount(0);
});
