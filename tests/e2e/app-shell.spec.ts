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
  await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Settings & permissions/ })).toBeVisible();
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
  await expect(page.getByText("No notifications")).toBeVisible();
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
  await page.getByRole("button", { name: "Connected accounts" }).click();
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();

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
  // Provider roster + capability routing live under Admin -> Assistant & AI.
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();

  await expect(page.getByRole("heading", { name: "Assistant & AI" })).toBeVisible();
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

  const emailBinding = page.getByLabel("Binding for Email extraction");
  await expect(emailBinding).toHaveValue("");
  await expect(page.getByText("Needs configuration", { exact: true })).toBeVisible();

  await emailBinding.selectOption("model:ai-model-auto");
  await expect(emailBinding).toHaveValue("model:ai-model-auto");
  await page.reload();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();
  await expect(page.getByLabel("Binding for Email extraction")).toHaveValue("model:ai-model-auto");

  await page.getByLabel("Binding for Email extraction").selectOption("model:ai-model-mailbox");
  await page.reload();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();
  await expect(page.getByLabel("Binding for Email extraction")).toHaveValue(
    "model:ai-model-mailbox"
  );

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
  await page.getByRole("button", { name: "Assistant & AI" }).click();

  await expect(page.getByText("API key needed", { exact: true })).toBeVisible();
  const emailBinding = page.getByLabel("Binding for Email extraction");
  await expect(emailBinding).toHaveValue("");
  await expect(emailBinding.locator("xpath=../..").getByText("Needs configuration")).toBeVisible();
});

test("serves PWA metadata", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  const manifest = (await response.json()) as { readonly name?: string };

  expect(response.ok()).toBe(true);
  expect(manifest.name).toBe("Moss");
});

test.describe("Chat drawer — Approve/Reject card", () => {
  test("renders Approve/Reject card and resolves on Approve", async ({ page }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    // Override the stream to return an action_request event.
    // Must be registered before page.goto because the stream connects at app load.
    const actionRequestEvent = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write the value 'test'",
      actionRequestId: "ar_test_1",
      toolName: "example.write",
      summary: "Write the value 'test'"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionRequestEvent}\n\n`
      });
    });

    // Mock the resolve endpoint, capturing the request so we can assert the
    // decision was actually transmitted — not merely that the card flipped to
    // "Approved" (a card could resolve optimistically without sending) (#171).
    let resolveUrl: string | undefined;
    let resolveBody: unknown;
    await page.route("**/api/chat/action-requests/*/resolve", (route) => {
      const request = route.request();
      resolveUrl = request.url();
      resolveBody = request.postDataJSON();
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    // Wait for the Approve/Reject card to appear
    await expect(page.locator(".action-request-card")).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".action-request-summary")).toContainText("Write the value 'test'");

    // Approve
    await page.locator(".action-request-card").getByRole("button", { name: "Approve" }).click();

    await expect(page.locator('.action-request-card [data-state="confirmed"]')).toHaveText(
      "Approved"
    );

    // Assert the approval decision and the path's action-request id actually went over the wire.
    expect(resolveBody).toEqual({ status: "confirmed" });
    expect(resolveUrl).toContain("/api/chat/action-requests/ar_test_1/resolve");
  });

  test("Reject resolves the card", async ({ page }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    const actionRequestEvent = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write 'y'",
      actionRequestId: "ar_test_2",
      toolName: "example.write",
      summary: "Write 'y'"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionRequestEvent}\n\n`
      });
    });

    let resolveUrl: string | undefined;
    let resolveBody: unknown;
    await page.route("**/api/chat/action-requests/*/resolve", (route) => {
      const request = route.request();
      resolveUrl = request.url();
      resolveBody = request.postDataJSON();
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    await expect(page.locator(".action-request-card")).toBeVisible({ timeout: 3000 });
    await page.locator(".action-request-card").getByRole("button", { name: "Reject" }).click();
    await expect(page.locator('.action-request-card [data-state="rejected"]')).toHaveText(
      "Not approved"
    );

    // Assert the rejection decision and the path's action-request id actually went over the wire.
    expect(resolveBody).toEqual({ status: "rejected" });
    expect(resolveUrl).toContain("/api/chat/action-requests/ar_test_2/resolve");
  });

  // #1518/1139-A: a same-tick double click must not fire two resolve requests. `setStatus` is
  // React state (not synchronous), so a second click in the same JS task before the first render
  // commit would previously still read the pre-click status and resolve again.
  test("a same-task double click on Approve sends exactly one resolve request", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    const actionRequestEvent = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write the value 'test'",
      actionRequestId: "ar_test_dbl",
      toolName: "example.write",
      summary: "Write the value 'test'"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionRequestEvent}\n\n`
      });
    });

    let resolveCallCount = 0;
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const released = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    await page.route("**/api/chat/action-requests/*/resolve", async (route) => {
      resolveCallCount += 1;
      await released;
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    await expect(page.locator(".action-request-card")).toBeVisible({ timeout: 3000 });

    // Two synchronous clicks in the same JS task — no await between them — so both handler
    // invocations race the same pre-mutate tick.
    await page.evaluate(() => {
      const button = document.querySelector(
        ".action-request-card .primary-button"
      ) as HTMLButtonElement;
      button.click();
      button.click();
    });

    await expect(page.locator(".action-request-actions")).toHaveCount(0);
    await expect(page.getByText("Resolving…")).toBeVisible();
    await expect(page.locator('.action-request-card [data-state="confirmed"]')).toHaveCount(0);

    gate.resolve?.();

    await expect(page.locator('.action-request-card [data-state="confirmed"]')).toHaveText(
      "Approved"
    );
    expect(resolveCallCount).toBe(1);
  });

  // #1518/1139-A: unmounting the drawer while a resolution is pending must not throw or warn —
  // guards the synchronous admission ref specifically, as the regression net for a future edit
  // that reintroduces an unmount-unsafe write.
  test("unmounting the drawer while a resolution is pending raises no console or page error", async ({
    page
  }) => {
    // Filters out unmocked-resource network noise (favicons, etc.) unrelated to the
    // admission-guard behavior under test; a React unmount-safety warning or an uncaught
    // exception would not match this pattern.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !/Failed to load resource|net::ERR_/.test(message.text())) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    const actionRequestEvent = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write the value 'test'",
      actionRequestId: "ar_test_unmount",
      toolName: "example.write",
      summary: "Write the value 'test'"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionRequestEvent}\n\n`
      });
    });

    const gate: { resolve: (() => void) | null } = { resolve: null };
    const released = new Promise<void>((resolve) => {
      gate.resolve = resolve;
    });
    await page.route("**/api/chat/action-requests/*/resolve", async (route) => {
      await released;
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    await expect(page.locator(".action-request-card")).toBeVisible({ timeout: 3000 });
    await page.locator(".action-request-card").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Resolving…")).toBeVisible();

    await page.getByRole("button", { name: "Close chat" }).click();

    gate.resolve?.();
    await page.waitForTimeout(200);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  // #1518/1139-A: new regression coverage for the existing expired-request copy/state, now
  // derived from the mutation's ApiError status instead of a message string-match.
  test("an expired (409) resolution shows the expiry message and no retry controls", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    const actionRequestEvent = JSON.stringify({
      kind: "action_request",
      text: "Approve or deny: Write the value 'test'",
      actionRequestId: "ar_test_expired",
      toolName: "example.write",
      summary: "Write the value 'test'"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionRequestEvent}\n\n`
      });
    });

    await page.route("**/api/chat/action-requests/*/resolve", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Action request expired" })
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    await expect(page.locator(".action-request-card")).toBeVisible({ timeout: 3000 });
    await page.locator(".action-request-card").getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText("This request expired — ask again.")).toBeVisible();
    await expect(
      page.locator(".action-request-card").getByRole("button", { name: "Approve" })
    ).toHaveCount(0);
    await expect(
      page.locator(".action-request-card").getByRole("button", { name: "Reject" })
    ).toHaveCount(0);
  });

  // #1264: mutation-tight frontend counterpart to
  // tests/integration/mcp-gateway-self-operation.test.ts's "first use after install grant runs
  // without an action card" — that test proves the real gateway emits ONLY an `action_result`
  // record (never `action_request`) for a granted-tier tool. This test feeds the live SSE stream
  // that exact event shape and proves the drawer can structurally never render an Approve/Reject
  // card for it, and never calls the resolve endpoint at all (a network-level proof, not just a
  // DOM-selector absence). The real chat turn that would produce this event end-to-end needs a
  // real chat model, which the UAT harness doesn't have — see
  // tests/uat/specs/1264-settings-self-operation.uat.spec.ts's file header.
  test("granted-tier settings tool executes with no Approve/Reject card (#1264)", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    const actionResultEvent = JSON.stringify({
      kind: "action_result",
      text: "Switched to dark mode.",
      toolName: "settings.themeMode.set",
      outcome: "executed"
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionResultEvent}\n\n`
      });
    });

    let resolveCallCount = 0;
    await page.route("**/api/chat/action-requests/*/resolve", (route) => {
      resolveCallCount += 1;
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    // action_result records render as durable outcomes, never Approve/Reject cards.
    const result = page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status");
    await expect(result).toContainText("Executed", { timeout: 3000 });
    await expect(result).toContainText("Switched to dark mode.");

    await expect(page.locator(".action-request-card")).toHaveCount(0);
    expect(resolveCallCount).toBe(0);
  });

  // #1310: proves the generic, declaration-driven invalidation wiring end-to-end at the
  // frontend seam — a chat-driven action_result carrying affectsQueryKeys triggers a
  // real query refetch and the DOM updates with no page.reload(). This mocks the SSE
  // stream and the themes route, so it does NOT by itself satisfy #1310's "real dev
  // instance" exit criterion (a live chat turn against a real model) — see the UAT spec
  // referenced in the previous test's comment for that proof.
  test("chat-driven settings write auto-refreshes theme UI with no reload (#1310)", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });

    let themeFetchCount = 0;
    await page.route("**/api/me/themes", (route) => {
      themeFetchCount += 1;
      const mode = themeFetchCount === 1 ? "light" : "dark";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          builtIn: [
            { id: "light", name: "Light", builtIn: true },
            { id: "dark", name: "Dark", builtIn: true }
          ],
          custom: [],
          activeId: mode,
          mode
        })
      });
    });

    const actionResultEvent = JSON.stringify({
      kind: "action_result",
      text: "Switched to dark mode.",
      toolName: "settings.themeMode.set",
      outcome: "executed",
      actionRequestId: "ar_theme_1",
      affectsQueryKeys: ["settings.themes"]
    });
    let streamServed = false;
    await page.route("**/api/chat/stream*", async (route) => {
      if (streamServed) {
        return;
      }
      streamServed = true;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: `data: ${actionResultEvent}\n\n`
      });
    });

    await page.goto("/");

    // Initial load fetches light mode before the chat-driven write ever happens.
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "light");

    await page.getByRole("button", { name: "Chat with Moss" }).click();

    const result = page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status");
    await expect(result).toContainText("Executed", { timeout: 3000 });
    await expect(result).toContainText("Switched to dark mode.");

    // No page.reload() anywhere above — the attribute flips purely from the generic
    // invalidation effect resolving "settings.themes" and refetching.
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark", {
      timeout: 3000
    });
    expect(themeFetchCount).toBeGreaterThanOrEqual(2);
  });
});
