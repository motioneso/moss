import { expect, test } from "@playwright/test";

import {
  createMockConnectorAccount,
  createMockConnectorProviders,
  createMockUser,
  createMockNotification,
  createMockTask,
  mockApi
} from "./mock-api.js";
import { createMockAiModel, createMockAiProvider } from "./mock-ai-api.js";

test("signs in and renders shell navigation", async ({ page }) => {
  await mockApi(page, {
    authenticated: false,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/today/);
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
  await expect(page.locator(".module-nav").getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.locator(".module-nav").getByRole("link", { name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat with Moss" })).toBeVisible();

  await page.getByRole("button", { name: /Account menu/ }).click();
  await expect(page.getByRole("menuitem", { name: /Notifications/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
});

test("gates a protected route behind sign-in when unauthenticated", async ({ page }) => {
  // Navigating directly to a protected route while unauthenticated must land on
  // the sign-in gate, not leak the protected surface (#171).
  await mockApi(page, {
    authenticated: false,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [createMockTask("task-1", "Owner-only secret task")]
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The protected shell navigation and any owner data must not be rendered.
  await expect(page.locator(".module-nav").getByRole("link", { name: "Tasks" })).toHaveCount(0);
  await expect(page.getByText("Owner-only secret task")).toHaveCount(0);
});

test("hides admin-only settings sections for a non-admin user", async ({ page }) => {
  // isInstanceAdmin:false must hide the Admin / Setup mode entirely (#171).
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin: false,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  // The recovered 2026-07-19 profile polish dropped the redundant "Role" row (its blurb read
  // "Member of this instance.") because the header badge already states the role. Assert the badge
  // instead, so this still proves a non-admin gets their own identity surface.
  await expect(page.locator(".prof__badges").getByText("Member", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin / Setup" })).toHaveCount(0);
  await expect(page.getByText("People & access")).toHaveCount(0);
});

test("people access uses approval model and revokes member sessions", async ({ page }) => {
  let revokeUrl: string | undefined;

  await mockApi(page, {
    authenticated: true,
    adminUsers: [
      createMockUser("user-1", "Owner User", "owner@example.test", {
        isInstanceAdmin: true,
        isBootstrapOwner: true
      }),
      createMockUser("member-1", "Member User", "member@example.test")
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    revokedAdminSessionCount: 3,
    tasks: []
  });

  await page.route("**/api/admin/users/*/revoke-sessions", async (route) => {
    revokeUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, count: 3 })
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Admin / Setup" }).click();

  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite/i })).toHaveCount(0);
  await expect(
    page.getByText("New people create an account, then wait for approval here.")
  ).toBeVisible();

  await page.getByRole("button", { name: "Actions for Member User" }).click();
  await page.getByRole("menuitem", { name: "Sign out everywhere" }).click();
  await expect(
    page.getByRole("dialog", { name: "Sign out Member User everywhere?" })
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Sign out Member User everywhere?" })
    .getByRole("button", { name: "Sign out everywhere" })
    .click();

  await expect.poll(() => revokeUrl).toContain("/api/admin/users/member-1/revoke-sessions");
  await expect(
    page.getByText("Member User signed out everywhere (3 sessions revoked)")
  ).toBeVisible();
  await expect(page.getByText(/session-/i)).toHaveCount(0);
});

test("creates and updates tasks through REST calls", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [createMockTask("task-1", "Existing secure task")]
  });

  await page.goto("/tasks");
  await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();

  await page.getByLabel("Task title").fill("Renew passport");
  await page.getByLabel("Task title").press("Enter");

  await expect(page.getByText("Renew passport")).toBeVisible();
});

test("lists and marks notifications read through REST calls", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [
      createMockNotification("notification-1", "New secure notice"),
      createMockNotification("notification-2", "Workspace notice")
    ],
    tasks: []
  });

  await page.goto("/notifications");
  await expect(page.getByRole("region", { name: "Notifications" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Unread\s*\(2\)/ })).toBeVisible();
  await expect(page.getByText("New secure notice")).toBeVisible();

  await page.getByLabel("Mark New secure notice read").click();
  await expect(page.getByRole("button", { name: /Unread\s*\(1\)/ })).toBeVisible();

  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByRole("button", { name: /Unread\s*\(0\)/ })).toBeVisible();
  await page.getByRole("button", { name: /Unread/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Notification list" })
      .getByText("No unread notifications", { exact: true })
  ).toBeVisible();
});

test("Calendar page renders its real empty data view", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    calendarEvents: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Day", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Week", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Month", exact: true })).toBeVisible();
  await expect(page.getByText("Calendar is coming soon.")).toHaveCount(0);
});

test("connector accounts panel shows existing accounts and supports revoke", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [
      createMockConnectorAccount("connector-1", {
        providerId: "google-email",
        providerDisplayName: "Google Email",
        scopes: ["gmail.readonly"],
        status: "active"
      })
    ],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();

  await expect(page.getByText("Google Email")).toBeVisible();
  await expect(page.getByText("Live connection")).toBeVisible();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page
    .getByRole("dialog", { name: "Revoke Google Email access?" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
});

test("configures chat and email extraction models through settings", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    aiModels: [
      createMockAiModel("ai-model-auto", {
        providerConfigId: "ai-provider-1",
        providerKind: "anthropic",
        providerDisplayName: "Anthropic",
        providerModelId: "gpt-4o",
        displayName: "gpt-4o",
        capabilities: ["chat", "tool-use", "json", "summarization"]
      }),
      createMockAiModel("ai-model-mailbox", {
        providerConfigId: "ai-provider-1",
        providerKind: "anthropic",
        providerDisplayName: "Anthropic",
        providerModelId: "mailbox-json",
        displayName: "Mailbox JSON",
        capabilities: ["json"]
      })
    ],
    aiProviders: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  // Provider roster + capability routing live under Admin -> AI providers.
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();

  await expect(page.getByRole("heading", { name: "AI providers" })).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  await expect(page.locator(".prov__name", { hasText: "Anthropic" })).toBeVisible();

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("Provider credential is valid.")).toBeVisible();

  // #982/#869 Lane B: connecting is the whole setup flow. Models appear automatically and the
  // old Discover/picker surfaces no longer exist. #2208 brought back "Refresh models" and
  // "Add model" as explicit per-provider actions; the Model id field only appears once
  // Add model is opened.
  // The Models section starts collapsed; its header toggles the list.
  await page.getByRole("button", { name: /^Models · \d+$/ }).click();
  await expect(page.locator(".mdl__id", { hasText: "gpt-4o" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Discover", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Discovered models")).toHaveCount(0);
  await expect(page.getByLabel("Model id")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh models", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add model", exact: true })).toBeVisible();

  // #870 Slice 1: services (Chat / Voice) replace the old capability-routing rows.
  // exact:true — the default substring match also hits the footer Note ("…follows the
  // services above"), so scope to the section heading div (strict-mode 2-element violation).
  await expect(page.getByText("Services", { exact: true })).toBeVisible();
  await expect(page.getByText(/Routing override .*not wired/)).toHaveCount(0);
  await page.getByLabel("Binding for Chat & briefing").selectOption("mode:reasoning");
  await expect(page.getByText("Service updated")).toBeVisible();

  const emailBinding = page.getByLabel("Binding for Email reading");
  await expect(emailBinding).toHaveValue("");
  // Scoped to the row: Focus (#2570) is also unbound here and shows the same text.
  await expect(emailBinding.locator("xpath=../..").getByText("Needs configuration")).toBeVisible();

  await emailBinding.selectOption("model:ai-model-auto");
  await expect(emailBinding).toHaveValue("model:ai-model-auto");
  await page.reload();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByLabel("Binding for Email reading")).toHaveValue("model:ai-model-auto");

  await page.getByLabel("Binding for Email reading").selectOption("model:ai-model-mailbox");
  await page.reload();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByLabel("Binding for Email reading")).toHaveValue("model:ai-model-mailbox");

  await page.getByRole("button", { name: "Remove Anthropic" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("No providers yet")).toBeVisible();
});

test("shows missing AI credentials as email-extraction configuration", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    aiProviders: [createMockAiProvider("ai-provider-1", { hasCredential: false })],
    aiModels: [
      createMockAiModel("ai-model-mailbox", {
        providerConfigId: "ai-provider-1",
        capabilities: ["json"]
      })
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();

  await expect(page.getByText("API key needed", { exact: true })).toBeVisible();
  const emailBinding = page.getByLabel("Binding for Email reading");
  await expect(emailBinding).toHaveValue("");
  await expect(emailBinding.locator("xpath=../..").getByText("Needs configuration")).toBeVisible();
});

test("serves PWA metadata", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  const manifest = (await response.json()) as { readonly name?: string };

  expect(response.ok()).toBe(true);
  expect(manifest.name).toBe("Moss");
});

test("desktop nav collapses to a remembered rail and phone keeps the drawer", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/today");
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();

  const sidebar = page.locator(".sidebar");
  const collapse = page.getByRole("button", { name: "Collapse navigation" });
  await expect(collapse).toBeVisible();
  const expandedWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(expandedWidth).toBeGreaterThanOrEqual(192);
  expect(expandedWidth).toBeLessThanOrEqual(196);

  await collapse.click();
  const expand = page.getByRole("button", { name: "Expand navigation" });
  await expect(expand).toBeVisible();
  const railWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(railWidth).toBeLessThanOrEqual(72);
  await expect(page.locator(".module-nav").getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
  const railAfterReload = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(railAfterReload).toBeLessThanOrEqual(72);

  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expect(page.getByRole("button", { name: "Collapse navigation" })).toBeVisible();
  const restoredWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(restoredWidth).toBeGreaterThanOrEqual(192);
  expect(restoredWidth).toBeLessThanOrEqual(196);

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand navigation" })).toHaveCount(0);
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth === window.innerWidth
  );
  expect(noOverflow).toBe(true);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(sidebar).not.toHaveClass(/open/);
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("stored rail leaves the phone drawer full", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/today");
  await expect(page.locator(".module-nav").getByRole("link", { name: "Today" })).toBeVisible();
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/today");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveClass(/open/);
  await expect(sidebar.getByText("Moss", { exact: true })).toBeVisible();
  await expect(page.locator(".module-nav").getByRole("link", { name: "Tasks" })).toBeVisible();
  const drawerWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(drawerWidth).toBeGreaterThan(200);
});
