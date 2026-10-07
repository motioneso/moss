import { expect, test } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

// #1265 (reopened-and-open #1121 tracks the UAT-harness gap this fills a mocked half of): the
// spec's exit criterion wants a real chat turn proving `selfOperationGrant: granted_at_install` +
// `executionPolicy: "auto"` tools run with no confirmation card. The dev-UAT harness cannot drive
// that turn for real — it is deliberately credential-free (tests/uat/seed/chunks/ai.ts seeds only
// a fake JSON-capability provider bound to module.news; there is no chat-capable seeded provider
// anywhere), so no seed level can make a real model choose to call a tool. That gap is model
// behavior, not a trust boundary: the backend decision of WHICH record kind a granted tool emits
// is already proven against a real DB + real gateway in
// tests/integration/mcp-gateway-self-operation.test.ts ("first use after install grant runs
// without an action card", "install grants for the sports module let sports.followTeam run
// without an action card"). What remained unproven was the frontend half: given those exact
// record kinds, does the UI actually withhold the card?
//
// An action_result (self-operation), the assistant reply and an action_request (needs
// confirmation) ride the SAME transcript. The reply and pending card prove the stream was
// consumed; only the pending request gets a card, and policy execution adds no technical row.
// The separate #1310 test in app-shell.spec.ts proves action_result still invalidates queries.
//
// See tests/uat/specs/self-operation-content-commands.uat.spec.ts for the harness-side fixmes
// that cite this file as their real proof, matching the tests/e2e/chat-drawer.spec.ts precedent
// already used for #1089/#1090.
test("self-operation tool executes with no confirmation card; a tool needing confirmation still gets one", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  const selfOpResult = JSON.stringify({
    kind: "action_result",
    text: "Executed: sports.followTeam",
    toolName: "sports.followTeam",
    outcome: "executed",
    decidedBy: "policy"
  });
  const reply = JSON.stringify({ kind: "reply", text: "You are now following the Yankees." });
  const needsConfirm = JSON.stringify({
    kind: "action_request",
    text: "Delete this event?",
    actionRequestId: "action-1",
    toolName: "calendar.deleteEvent",
    summary: "Delete this event?"
  });

  // Same one-shot-then-hold pattern as chat-drawer.spec.ts: EventSource replays a closed
  // stream on reconnect, so serve the records once and hold the reconnect open.
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) return;
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `data: ${selfOpResult}\n\ndata: ${reply}\n\ndata: ${needsConfirm}\n\n`
    });
  });
  await page.route("**/api/chat/turn", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "ok" })
    })
  );
  await page.route("**/api/chat/clear", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  // The tool that still needs confirmation renders its card, proving the mock/harness path works.
  await expect(drawer.locator(".action-request-card")).toHaveCount(1);
  await expect(drawer.locator(".action-request-card")).toContainText("Delete this event?");

  await expect(drawer.locator(".chatd-bubble")).toHaveText("You are now following the Yankees.");
  await expect(drawer.getByRole("status")).toHaveCount(0);
  await expect(drawer.getByText("Executed: sports.followTeam")).toHaveCount(0);
});
