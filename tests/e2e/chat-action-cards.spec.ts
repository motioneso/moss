import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

// Component wiring only: deterministic SSE fixtures exercise parser → transcript → real card.
// This is not the Slice 8 live-data/provider proof.
for (const appearance of [
  { name: "desktop light", width: 1440, theme: "forest", mode: "light" },
  { name: "phone dark", width: 390, theme: "forest", mode: "dark" },
  { name: "small phone dark", width: 320, theme: "forest", mode: "dark" },
  { name: "desktop canyon", width: 1440, theme: "canyon", mode: "light" }
]) {
  test(`app action SSE target and field rows reach the card (${appearance.name}; component wiring)`, async ({
    page
  }) => {
    await page.setViewportSize({ width: appearance.width, height: 900 });
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });
    let served = false;
    await page.route("**/api/chat/stream*", (route) => {
      const event = {
        kind: "action_request",
        text: "Change custom theme",
        summary: "app.callAction /api/themes/raw-id must not be displayed",
        outcomeTitle: "Change custom theme",
        actionRequestId: "app-card-wiring",
        toolName: "app.callAction",
        outsideContentNotice: false,
        details: {
          presentation: "human",
          target: "Weekend <b>theme</b>\n  " + "long-unbroken-name".repeat(30),
          fields: [
            { label: "Name", value: "**Evening**" },
            { label: "Enabled", value: "false" }
          ]
        }
      };
      const body = served ? "" : `data: ${JSON.stringify(event)}\n\n`;
      served = true;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();
    await page.evaluate(({ theme, mode }) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.setAttribute("data-color-mode", mode);
    }, appearance);
    const card = page.getByRole("region", { name: "Action request", exact: true });
    await expect(card).toBeVisible();
    await expect(card.locator(".jds-card--pad-sm")).toBeVisible();
    await expect(card.getByRole("heading", { name: "Change custom theme" })).toBeVisible();
    expect(await card.locator(".action-request-target").textContent()).toBe(
      "Weekend <b>theme</b>\n  " + "long-unbroken-name".repeat(30)
    );
    await expect(card.locator("dt")).toHaveText(["Name", "Enabled"]);
    await expect(card.locator("dd")).toHaveText(["**Evening**", "false"]);
    await expect(card.locator("b, strong, svg")).toHaveCount(0);
    await expect(card).not.toContainText("/api/themes/raw-id");
    await expect(
      card.getByText("Moss read something from outside your account before asking this.", {
        exact: true
      })
    ).toHaveCount(0);
    const approve = card.getByRole("button", { name: "Approve", exact: true });
    const reject = card.getByRole("button", { name: "Reject", exact: true });
    await expect(approve).toBeVisible();
    await expect(reject).toBeVisible();
    const first = await approve.boundingBox();
    const second = await reject.boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first && second) {
      const gap =
        Math.abs(first.y - second.y) < 1
          ? second.x - first.x - first.width
          : second.y - first.y - first.height;
      expect(gap).toBeGreaterThanOrEqual(8);
    }
    expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  });
}

for (const width of [1440, 390, 320]) {
  test(`connected-tool arguments stay complete at ${width}px (component wiring)`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: createMockConnectorProviders(),
      notifications: [],
      tasks: []
    });
    const exactArguments = JSON.stringify(
      {
        name: "Kitchen light",
        options: { values: [false, 0, null, ["<b>literal</b>", { note: "  exact\ntext" }]] },
        large: "long-unbroken-argument".repeat(90)
      },
      null,
      2
    );
    const record = {
      kind: "action_request",
      text: "Technical summary must not be displayed",
      summary: "Model-written summary must not be displayed",
      actionRequestId: "external-card-wiring",
      externalTool: true,
      outcomeTitle: "Connected tool request",
      toolName: "example.set_light_state",
      exactArguments
    };
    let served = false;
    await page.route("**/api/chat/stream*", (route) => {
      const body = served ? "" : `data: ${JSON.stringify(record)}\n\n`;
      served = true;
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();
    const card = page.getByRole("region", { name: "Action request", exact: true });
    await expect(card.getByRole("heading", { name: "Connected tool request" })).toBeVisible();
    await expect(card.locator(".action-request-target")).toHaveText("example.set_light_state");
    expect(await card.locator(".action-request-arguments").textContent()).toBe(exactArguments);
    expect(await card.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(card.locator("b, svg")).toHaveCount(0);
    await expect(card).not.toContainText("summary must not be displayed");
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Reject", exact: true })).toBeEnabled();
  });
}

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
      summary: "Technical summary must not be displayed",
      outcomeTitle: "Write the value 'test'",
      details: {
        presentation: "human",
        target: "Example setting",
        fields: [{ label: "Value", value: "test" }]
      }
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
    await expect(page.locator(".action-request-title")).toContainText("Write the value 'test'");

    // The native shared button remains keyboard-operable.
    const approve = page.locator(".action-request-card").getByRole("button", { name: "Approve" });
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.locator(".action-request-card").getByRole("button", { name: "Reject" })
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(approve).toBeFocused();
    await expect
      .poll(() => approve.evaluate((button) => button.matches(":focus-visible")))
      .toBe(true);
    await expect(approve).not.toHaveCSS("box-shadow", "none");
    await approve.press("Enter");

    await expect(
      page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status")
    ).toHaveText("Approved · Write the value 'test'");
    await expect(page.locator(".action-request-outcome")).toBeFocused();
    await expect(page.locator(".action-request-outcome")).toHaveCSS("outline-style", "none");
    await expect(page.locator(".action-request-card")).toHaveCount(0);
    await expect(page.getByText("Example setting", { exact: true })).toHaveCount(0);

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
      summary: "Technical summary must not be displayed",
      outcomeTitle: "Write 'y'",
      details: {
        presentation: "human",
        target: "Example setting",
        fields: [{ label: "Value", value: "y" }]
      }
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
    await expect(
      page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status")
    ).toHaveText("You declined · Write 'y'");
    await expect(page.locator(".action-request-card")).toHaveCount(0);
    await expect(page.getByText("Example setting", { exact: true })).toHaveCount(0);

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
      summary: "Technical summary must not be displayed",
      outcomeTitle: "Write the value 'test'",
      details: {
        presentation: "human",
        target: "Example setting",
        fields: [{ label: "Value", value: "test" }]
      }
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
    await page
      .locator(".action-request-card")
      .getByRole("button", { name: "Approve", exact: true })
      .evaluate((element) => {
        const button = element as HTMLButtonElement;
        button.click();
        button.click();
      });

    await expect(
      page.locator(".action-request-actions").getByRole("button", { name: "Approve", exact: true })
    ).toBeDisabled();
    await expect(
      page.locator(".action-request-actions").getByRole("button", { name: "Reject", exact: true })
    ).toBeDisabled();
    await expect(page.getByText("Resolving…")).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status")
    ).toHaveText("Resolving…");

    gate.resolve?.();

    await expect(
      page.getByRole("dialog", { name: "Chat with Moss" }).getByRole("status")
    ).toHaveText("Approved · Write the value 'test'");
    await expect(page.locator(".action-request-card")).toHaveCount(0);
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
      summary: "Technical summary must not be displayed",
      outcomeTitle: "Write the value 'test'",
      details: {
        presentation: "human",
        target: "Example setting",
        fields: [{ label: "Value", value: "test" }]
      }
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

  // #1518/1139-A: a 409 is a terminal timeout, derived from the mutation's ApiError status.
  test("an expired (409) resolution shows a quiet timeout and no retry controls", async ({
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
      summary: "Technical summary must not be displayed",
      outcomeTitle: "Write the value 'test'",
      details: {
        presentation: "human",
        target: "Example setting",
        fields: [{ label: "Value", value: "test" }]
      }
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

    const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
    await expect(drawer.getByRole("status")).toHaveText("Timed out · Write the value 'test'");
    await expect(drawer.locator(".action-request-card")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Reject" })).toHaveCount(0);
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
      text: "Executed: settings.themeMode.set",
      toolName: "settings.themeMode.set",
      summary: "Switch to dark mode",
      decidedBy: "policy",
      outcome: "executed",
      actionRequestId: "ar_theme_auto"
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
        body: `data: ${actionResultEvent}\n\ndata: ${JSON.stringify({ kind: "reply", text: "Switched to dark mode." })}\n\n`
      });
    });

    let resolveCallCount = 0;
    await page.route("**/api/chat/action-requests/*/resolve", (route) => {
      resolveCallCount += 1;
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Chat with Moss" }).click();

    // Auto-run completion stays visible as a quiet result without requiring approval.
    const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
    await expect(drawer.locator(".chatd-bubble")).toHaveText("Switched to dark mode.");
    await expect(drawer.getByRole("status")).toHaveText("Done: Switch to dark mode");
    await expect(drawer.getByText("Executed: settings.themeMode.set")).toHaveCount(0);

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
      text: "Executed: settings.themeMode.set",
      toolName: "settings.themeMode.set",
      summary: "Switch to dark mode",
      decidedBy: "policy",
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
        body: `data: ${actionResultEvent}\n\ndata: ${JSON.stringify({ kind: "reply", text: "Switched to dark mode." })}\n\n`
      });
    });

    await page.goto("/");

    // Initial load fetches light mode before the chat-driven write ever happens.
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "light");

    await page.getByRole("button", { name: "Chat with Moss" }).click();

    const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
    await expect(drawer.locator(".chatd-bubble")).toHaveText("Switched to dark mode.");
    await expect(drawer.getByRole("status")).toHaveText("Done: Switch to dark mode");
    await expect(drawer.getByText("Executed: settings.themeMode.set")).toHaveCount(0);

    // No page.reload() anywhere above — the attribute flips purely from the generic
    // invalidation effect resolving "settings.themes" and refetching. The refetch round-trip is
    // slower than the 3s used elsewhere for a direct DOM assertion, so allow the file's standard
    // 5s wait rather than racing it (#app-shell dark-mode flake).
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark", {
      timeout: 5000
    });
    expect(themeFetchCount).toBeGreaterThanOrEqual(2);
  });
});
