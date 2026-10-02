import { expect, test, type Page } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/** #2913 the chat panel behaves like a dialog for keyboard users. */

async function setup(page: Page) {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    chatMessages: {},
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.route(/\/api\/ai\/capability-route\/chat$/, (route) =>
    route.fulfill({
      status: 200,
      json: {
        route: { capability: "chat", available: true, reason: "matched-active-model", model: null }
      }
    })
  );
  await page.goto("/");
}

test("opening moves focus into the message box, Escape closes and returns focus", async ({
  page
}) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "Chat with Moss" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog.getByRole("textbox")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("on a phone, Tab stays inside the open chat", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("textbox")).toBeFocused();

  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => document.activeElement?.closest("[role='dialog']") !== null
    );
    expect(inside).toBe(true);
  }
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press("Shift+Tab");
    const inside = await page.evaluate(
      () => document.activeElement?.closest("[role='dialog']") !== null
    );
    expect(inside).toBe(true);
  }
});
