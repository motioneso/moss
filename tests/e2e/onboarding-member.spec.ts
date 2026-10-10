import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, mockApi, type MockApiState } from "./mock-api.js";
import { defaultOnboardingStatus } from "./mock-onboarding-api.js";

function memberState(overrides: Partial<MockApiState> = {}): MockApiState {
  return {
    authenticated: true,
    isInstanceAdmin: false,
    notifications: [],
    tasks: [],
    // The member connector / API-key-opt-out steps query these module endpoints (client-side
    // `done` derivation); the connector mock state is required (not optional) on MockApiState.
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    // Drive the member onboarding branch: not the bootstrap owner, onboarding incomplete.
    isBootstrapOwner: false,
    onboardingStatus: {
      role: "member",
      completed: false,
      steps: { apiKeyOptOut: { done: false }, connectors: { done: false } }
    },
    ...overrides
  };
}

test("active member sees the member step array (no CLI-auth/multiplexer) and can finish", async ({
  page
}) => {
  await mockApi(page, memberState());
  await page.goto("/");
  await expect(page.getByText("Getting started")).toBeVisible();
  await expect(page.getByLabel("Onboarding progress").getByText("Member")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You’ve got your own Moss." })).toBeVisible();
  await expect(page.getByText("Your tasks and account connections remain private.")).toBeVisible();
  await expect(page.getByText("Skip setup and open the app.")).toBeVisible();
  await expect(page.getByText("Tweaks")).toHaveCount(0);
  // Member-specific steps exist; founder-only steps do NOT.
  await expect(page.getByText(/CLI auth/i)).toHaveCount(0);
  await expect(page.getByText(/multiplexer/i)).toHaveCount(0);

  // Advancing into the API-key step renders a react-router <Link> — this MUST NOT crash the
  // app (regression guard: the wizard must be inside a Router). If the wizard were rendered
  // outside BrowserRouter, the <Link> would throw a context invariant here.
  await page.getByRole("button", { name: /Start setup/ }).click();
  await expect(page.getByRole("heading", { name: "Moss is ready to use." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Use the shared setup/i })).toBeVisible();
  // Members inherit the shared subscription; saving a provider is admin-only, so no key box.
  await expect(page.getByRole("button", { name: /Add a personal key/i })).toHaveCount(0);
  await expect(page.getByLabel("Personal AI key")).toHaveCount(0);
});

test('"Skip setup" reaches the app shell', async ({ page }) => {
  await mockApi(page, memberState());
  await page.goto("/");
  await page.getByRole("button", { name: "Skip setup" }).first().click();
  await page
    .getByRole("dialog", { name: "Skip setup without connecting a provider?" })
    .getByRole("button", { name: "Skip anyway" })
    .click();
  await expect(page).toHaveURL(/\/today/);
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
});

test("a completed member skips the wizard and sees the shell", async ({ page }) => {
  await mockApi(
    page,
    memberState({
      onboardingStatus: {
        role: "member",
        completed: true,
        steps: { apiKeyOptOut: { done: false }, connectors: { done: false } }
      }
    })
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/today/);
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
});

test("founder still sees the founder wizard (regression)", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: true,
    isBootstrapOwner: true,
    notifications: [],
    tasks: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    // Pending founder status drives the founder wizard (the mock defaults to "completed").
    onboardingStatus: defaultOnboardingStatus()
  });
  await page.goto("/");
  // Founder onboarding shape comes from the spine's mock; assert a founder-only step is visible.
  await expect(page.getByRole("heading", { name: "Let’s get your Moss set up." })).toBeVisible();
  await expect(
    page.getByLabel("Onboarding progress").getByRole("button", { name: /Assistant/ })
  ).toBeVisible();
  await expect(page.getByLabel("Onboarding progress").getByText("Owner")).toBeVisible();
  await expect(page.getByText("Control channel")).toBeVisible();
});

test("status-error fall-through: a failing /api/onboarding/status does NOT trap the member", async ({
  page
}) => {
  // Onboarding is OPTIONAL — if its status endpoint errors, the app must NOT block the member
  // in the wizard. The app.tsx gate fires only when `!onboardingQuery.isError`, so a 500
  // falls through to the shell (Task 10.3 predicate).
  await mockApi(page, memberState());
  // Override the onboarding status route to fail AFTER the base mock is installed.
  await page.route("**/api/onboarding/status", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/today/);
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You’ve got your own Moss." })).toHaveCount(0);
});
