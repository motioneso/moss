import { expect, test, type Page } from "@playwright/test";

import { createMockUser, mockApi } from "./mock-api.js";
import { myModulesResponse } from "./mock-modules.js";

async function mockSettingsApi(page: Page, isInstanceAdmin = true): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin,
    adminUsers: isInstanceAdmin
      ? [
          createMockUser("user-1", "Owner User", "owner@example.test", {
            isInstanceAdmin: true,
            isBootstrapOwner: true
          }),
          createMockUser("pending-1", "Pending User", "pending@example.test", {
            status: "pending"
          }),
          createMockUser("member-1", "Member User", "member@example.test")
        ]
      : undefined,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  await page.route("**/api/me/quiet-hours", (route) =>
    route.fulfill({
      json: {
        quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" }
      }
    })
  );
  if (isInstanceAdmin) {
    await page.route("**/api/admin/registration", (route) =>
      route.fulfill({ json: { registrationEnabled: true, requiresApproval: true } })
    );
  }
}

test("desktop shell renders grouped IA, merged panes, and history-aware mode changes", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  const nav = page.getByRole("navigation", { name: "Settings categories" });
  for (const group of ["Your account", "Moss", "Connections", "Extensions"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(nav.getByRole("button")).toHaveCount(12);
  await expect(nav.getByRole("button", { name: "Recently Released" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Integrations" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Profile & account" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "General" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  for (const section of [
    "Account",
    // Renamed from "Locale" by the recovered 2026-07-19 profile polish: the group now holds a time
    // zone plus a (disabled) language & region control, so "Location" describes it honestly.
    "Location",
    "Weather",
    "Quiet hours",
    "Active sessions",
    "Your data",
    "Danger zone"
  ]) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }

  await nav.getByRole("button", { name: "Modules" }).click();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();

  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await expect(page).toHaveURL(/\?section=people$/);
  for (const group of ["Access", "AI & extensions", "Operations"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(nav.getByRole("button")).toHaveCount(6);
  await expect(nav.getByRole("button", { name: "Identity & registration" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
  for (const section of ["Registration", "Pending approval", "Members"]) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Actions for Member User" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("button", { name: "Personal" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\?section=people$/);
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
});

test("short desktop rail reaches its final destination by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  const nav = page.getByRole("navigation", { name: "Settings categories" });
  const first = nav.getByRole("button", { name: "Account & preferences" });
  const last = nav.getByRole("button").last();
  await first.focus();
  for (let index = 0; index < 11; index += 1) await page.keyboard.press("Tab");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
});

test("narrow shell keeps groups and destinations reachable without horizontal overflow", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  const nav = page.getByRole("navigation", { name: "Settings categories" });
  for (const group of ["Your account", "Moss", "Connections", "Extensions"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await nav.getByRole("button", { name: "Modules" }).click();
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();

  await page.getByRole("button", { name: "Admin / Setup" }).click();
  for (const group of ["Access", "AI & extensions", "Operations"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
  await nav.getByRole("button", { name: "People & access" }).focus();
  await expect(nav.getByRole("button", { name: "People & access" })).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("non-admin direct admin deep link mounts no admin surface or request", async ({ page }) => {
  await mockSettingsApi(page, false);
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/")) {
      adminRequests.push(request.url());
    }
  });

  await page.goto("/settings?section=people");

  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin / Setup" })).toHaveCount(0);
  await expect(page.getByText("People & access", { exact: true })).toHaveCount(0);
  expect(adminRequests).toEqual([]);
});

test("modules preserve list/detail URL recovery for legacy and contributed settings", async ({
  page
}) => {
  await mockSettingsApi(page);
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...myModulesResponse.modules,
          {
            id: "sports",
            name: "Sports",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true
          }
        ]
      }
    })
  );
  await page.route("**/api/sports/catalog", (route) =>
    route.fulfill({ json: { competitions: [], degraded: false } })
  );
  await page.route("**/api/sports/follows", (route) => route.fulfill({ json: { follows: [] } }));
  await page.goto("/settings?section=modules");

  for (const moduleName of ["Briefings", "Chat", "Notifications", "Sports"]) {
    await expect(page.getByRole("button", { name: `Configure ${moduleName}` })).toBeVisible();
  }
  for (const requiredName of ["Briefings", "Chat", "Notifications"]) {
    await expect(page.getByRole("checkbox", { name: `Use ${requiredName}` })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Configure Chat" }).click();
  await expect(page).toHaveURL(/section=modules&module=chat$/);
  await expect(page.getByRole("button", { name: "Back to modules" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();

  await page.getByRole("button", { name: "Configure Sports" }).click();
  await expect(page).toHaveURL(/section=modules&module=sports$/);
  await expect(page.getByRole("button", { name: "Back to modules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sports" })).toBeVisible();
  await page.getByRole("button", { name: "Back to modules" }).click();
  await expect(page).toHaveURL(/\?section=modules$/);

  await page.getByRole("button", { name: "Configure Sports" }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Modules" })
    .click();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
});

test("data export resumes across remount and clears on new/expired job", async ({ page }) => {
  await mockSettingsApi(page);

  let job1Status: "pending" | "building" | "ready" = "pending";
  let postCount = 0;
  await page.route("**/api/me/export", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    postCount += 1;
    job1Status = "building";
    await route.fulfill({ json: { jobId: "job-1", status: "pending" } });
  });
  await page.route("**/api/me/export/status/job-1", (route) =>
    route.fulfill({ json: { jobId: "job-1", status: job1Status } })
  );

  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings categories" });

  // 1. Baseline: start an export, building state renders.
  await page.getByRole("button", { name: "Prepare export" }).click();
  await expect(page.getByText("Building your archive…")).toBeVisible();
  expect(postCount).toBe(1);

  // 2. Remount DataExport by navigating away and back; the job resumes, no second POST.
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByText("Building your archive…")).toBeVisible();
  expect(postCount).toBe(1);

  // 3. Once ready, the Download link targets the resumed job id.
  job1Status = "ready";
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "/api/me/export/download/job-1"
  );

  // 4. "Prepare a new export" clears the persisted id, not just in-memory state.
  await page.getByRole("button", { name: "Prepare a new export" }).click();
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
  ).toBeNull();

  // 5. A resumed-but-gone job (404) falls back to idle and clears storage.
  await page.addInitScript(() => {
    window.sessionStorage.setItem("moss.settings.export-job-id", "job-2");
  });
  await page.route("**/api/me/export/status/job-2", (route) =>
    route.fulfill({ status: 404, json: { message: "not found" } })
  );
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
  ).toBeNull();
});
