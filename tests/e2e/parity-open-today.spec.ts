import { expect, test } from "@playwright/test";

import { openToday } from "../uat/visual-parity/seed.js";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";

const FAKE_TODAY = `
  <!doctype html>
  <html><body>
    <main class="content-surface">
      <main class="center-screen"><p>Loading Moss</p></main>
    </main>
  </body></html>
`;

async function routeTodayDocument(
  page: Parameters<typeof openToday>[0],
  html: string
): Promise<void> {
  await page.route("**/today", async (route) => {
    if (route.request().resourceType() === "document") {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    } else {
      await route.continue();
    }
  });
}

test("openToday fails while the loading screen is inside the shell", async ({ page }) => {
  await routeTodayDocument(page, FAKE_TODAY);
  const opened = openToday(page, new Date("2026-09-22T12:00:00Z"));
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    document.querySelector("main.center-screen")?.replaceWith(
      Object.assign(document.createElement("section"), {
        className: "today-hero",
        textContent: "Today"
      })
    );
  });
  await opened;
  await expect(page.locator(".today-hero")).toBeVisible();
});

test("openToday copes with the real loading order", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.route("**/today-page*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await openToday(page, new Date("2026-09-22T12:00:00Z"));
  await expect(page.locator(".today-hero")).toBeVisible();
});
