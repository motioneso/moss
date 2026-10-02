import { expect, test, type Page } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/**
 * #2919 chat panel ready state: the header status, dot and message box follow the same
 * "is a chat model available" answer as the rest of the panel.
 *
 * Only the capability-route reply differs between tests; it is registered after mockApi so it wins.
 */

type Reason = "matched-active-model" | "no-active-model" | "admin-pin-unavailable";

async function openChat(page: Page, reason: Reason) {
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
          available: reason === "matched-active-model",
          reason,
          model: null
        }
      }
    })
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  return page.getByRole("dialog", { name: "Chat with Moss" });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 }
]) {
  test.describe(`chat ready state (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a model is available: ready status and a usable message box", async ({ page }) => {
      const drawer = await openChat(page, "matched-active-model");

      await expect(drawer.locator(".chatd__status")).toHaveText("Here when you need me");
      await expect(drawer.locator(".chatd__status")).not.toHaveClass(/chatd__status--offline/);
      await expect(drawer.getByRole("textbox", { name: "Message Moss" })).toBeEnabled();
      await expect(drawer.locator(".chatd-connect-cta")).toHaveCount(0);
    });

    test("no model: says so, no message box, link opens provider settings by keyboard", async ({
      page
    }) => {
      const drawer = await openChat(page, "no-active-model");

      await expect(drawer.locator(".chatd__status")).toHaveText("Not connected");
      await expect(drawer.locator(".chatd__status")).toHaveClass(/chatd__status--offline/);
      await expect(drawer.getByRole("textbox")).toHaveCount(0);
      const link = drawer.locator(".chatd-connect-cta");
      await expect(link).toHaveText("Connect a provider");

      await link.focus();
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/settings\?section=assistant/);
    });

    test("locked model unavailable: header says so and the message box is disabled", async ({
      page
    }) => {
      const drawer = await openChat(page, "admin-pin-unavailable");

      await expect(drawer.locator(".chatd__status")).toHaveText("Model unavailable");
      await expect(drawer.getByRole("textbox", { name: "Message Moss" })).toBeDisabled();
      await expect(drawer.locator(".chatd-lock-warn")).toBeVisible();
    });
  });
}
