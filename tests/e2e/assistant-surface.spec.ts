import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-chat-model.js";
import { mockAssistantSurfaceWebModule } from "./mock-modules.js";

test("embedded assistant owns chat presence and restores the drawer on unmount (#1196)", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await mockAssistantSurfaceWebModule(page);

  const reply = JSON.stringify({ kind: "reply", text: "**Embedded reply**" });
  const actionRequest = JSON.stringify({
    kind: "action_request",
    text: "Approve profile",
    actionRequestId: "action-1",
    toolName: "demo-module.profile.approve",
    summary: "Approve profile",
    outcomeTitle: "Approve profile",
    details: { presentation: "human", target: "Your profile", fields: [] }
  });
  // The shell owns exactly ONE stream today (the drawer), so every embedded surface renders the
  // same records via recordsForSurface. The second shell-owned stream that used to be keyed to a
  // specific module route was removed with that module (2026-07-25 reset) — a module wanting an
  // isolated transcript has to earn a generic seam in the rebuild, so this mock no longer branches
  // on the surface param. #1196's contract (presence, rendering, composer) is what's under test.
  await page.route("**/api/chat/stream*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `data: ${reply}\n\ndata: ${actionRequest}\n\n`
    });
  });
  const turnTexts: string[] = [];
  await page.route("**/api/chat/turn", async (route) => {
    turnTexts.push((route.request().postDataJSON() as { text: string }).text);
    await route.fulfill({ json: { reply: "ok" } });
  });

  await page.goto("/");
  const chatToggle = page.getByRole("button", { name: "Chat with Moss" });
  await chatToggle.click();
  await expect(page.getByRole("dialog", { name: "Chat with Moss" })).toBeVisible();

  await page.getByRole("link", { name: "Demo Module" }).click();

  const surface = page.locator(".assistant-surface");
  await expect(surface).toBeVisible();
  await expect(chatToggle).toBeEnabled();
  await expect(page.getByRole("dialog", { name: "Chat with Moss" })).toHaveCount(0);
  // `.first()` throughout: the mocked SSE response ends, so EventSource reconnects and replays
  // these records. Real streams stay open — the replay is a fixture artifact, not host behavior.
  await expect(surface.locator(".chatd-md strong").first()).toHaveText("Embedded reply");
  await expect(surface.locator(".action-request-card").first()).toBeVisible();
  await expect(surface.locator(".assistant-surface__row").nth(0)).toContainText("Scripted intro");
  await expect(surface.locator(".assistant-surface__row").nth(1)).toContainText("Scripted answer");
  await expect(
    surface.locator(".assistant-surface__row--assistant .assistant-surface__identity").first()
  ).toContainText("Moss");
  await expect(
    surface.locator(".assistant-surface__typing-row .assistant-surface__identity")
  ).toContainText("Moss");
  await expect(
    surface.locator(".assistant-surface__row--control .assistant-surface__identity")
  ).toContainText("Moss");

  await surface.getByRole("button", { name: "Route draft inline" }).click();
  const composer = surface.getByRole("textbox", { name: "Message Moss" });
  await expect(composer).toHaveValue("Draft routed inline");
  await expect(composer).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Chat with Moss" })).toHaveCount(0);

  await composer.fill("Enter sends once");
  await composer.press("Enter");
  await expect.poll(() => turnTexts).toEqual(["Enter sends once"]);

  await composer.fill("Line one");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("Line one\n");
  expect(turnTexts).toEqual(["Enter sends once"]);
  await composer.type("Line two");
  await surface.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => turnTexts).toEqual(["Enter sends once", "Line one\nLine two"]);

  await composer.fill("Composing text");
  await composer.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })
    )
  );
  await expect(composer).toHaveValue("Composing text");
  expect(turnTexts).toEqual(["Enter sends once", "Line one\nLine two"]);
  await surface.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => turnTexts)
    .toEqual(["Enter sends once", "Line one\nLine two", "Composing text"]);

  await chatToggle.click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  // One shell-owned stream means the drawer shows the SAME transcript the embedded surface does.
  // Isolating a module's transcript from the drawer is a rebuild decision, not host behavior today.
  // `.first()` because the mocked SSE response ENDS (a real stream stays open), so EventSource
  // reconnects and replays these records — a fixture artifact, not a host duplication bug.
  await expect(drawer.locator(".chatd-md strong").first()).toHaveText("Embedded reply");
  await chatToggle.click();

  await page.getByRole("link", { name: "Today" }).click();
  await expect(chatToggle).toBeEnabled();
});
