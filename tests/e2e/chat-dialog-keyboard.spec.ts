import { expect, test, type Page } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/** #2913 the chat panel behaves like a dialog for keyboard users. */

async function setup(page: Page, options: { reason?: string; draftModule?: boolean } = {}) {
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
        route: {
          capability: "chat",
          available: (options.reason ?? "matched-active-model") === "matched-active-model",
          reason: options.reason ?? "matched-active-model",
          model: null
        }
      }
    })
  );
  if (options.draftModule) {
    await page.route("**/api/modules", (route) =>
      route.fulfill({
        status: 200,
        json: {
          modules: [
            {
              id: "draftmod",
              name: "Draft module",
              version: "0.1.0",
              lifecycle: "optional",
              navigation: [],
              settings: [],
              external: true,
              draft: true
            }
          ]
        }
      })
    );
  }
  await page.goto(options.draftModule ? "/m/draftmod" : "/");
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

test("with the message box disabled, focus still lands in the panel and Escape works", async ({
  page
}) => {
  await setup(page, { reason: "admin-pin-unavailable" });
  const opener = page.getByRole("button", { name: "Chat with Moss" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog.getByRole("textbox", { name: "Message Moss" })).toBeDisabled();
  await expect(dialog).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("on a phone beside a running draft, the chat is still a modal dialog", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { draftModule: true });
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog).toHaveClass(/chatd--docked/);
  await expect(dialog).toHaveAttribute("aria-modal", "true");
});

test("unsent chat text survives resizing across the side-panel breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await setup(page);
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  const box = dialog.getByRole("textbox");
  await box.fill("half-written question");

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(box).toHaveValue("half-written question");

  await box.fill("still half-written");
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(box).toHaveValue("still half-written");
});
