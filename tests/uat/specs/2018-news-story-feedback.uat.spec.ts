import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

test.setTimeout(300_000);

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function waitForFeedbackMenu(page: Page, path: "news" | "today"): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await page.goto(`${baseURL()}/${path}`);
    const menu = page.getByRole("button", { name: /^Feedback for / }).first();
    try {
      await menu.waitFor({ state: "visible", timeout: 8_000 });
      const label = await menu.getAttribute("aria-label");
      if (!label) throw new Error("News story feedback button had no accessible label");
      return label.replace(/^Feedback for /, "");
    } catch {
      // The first News response can be the unregistered live-feed fallback while refresh runs.
    }
  }
  throw new Error("News did not show a feedback action within 180 seconds");
}

test("saves story feedback and manages it from News Settings", async ({ page }) => {
  await signIn(page);
  await waitForFeedbackMenu(page, "today");
  const headline = await waitForFeedbackMenu(page, "news");
  const menu = page.getByRole("button", { name: `Feedback for ${headline}` }).first();

  await menu.click();
  const moreResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/me/usefulness-feedback") &&
      response.request().method() === "POST"
  );
  await page.getByRole("menuitem", { name: "More like this" }).click();
  expect((await moreResponse).status()).toBe(201);

  const lessHeadline = await waitForFeedbackMenu(page, "news");
  const lessMenu = page.getByRole("button", { name: `Feedback for ${lessHeadline}` }).first();
  await lessMenu.click();
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  await page.getByLabel("Why less like this?").fill("This is not useful to me.");
  const lessResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/me/usefulness-feedback") &&
      response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Save" }).click();
  expect((await lessResponse).status()).toBe(201);

  await page.goto(`${baseURL()}/settings?section=modules&module=news`);
  const feedback = page.locator(
    'section[aria-label="Story preferences"], section[aria-label="News story feedback"]'
  );
  await expect(feedback).toBeVisible();
  const row = feedback.locator("li").filter({ hasText: lessHeadline });
  await expect(row).toContainText("Less like this");
  await row.getByRole("button", { name: "Edit reason" }).click();
  await row.getByLabel("Reason").fill("I want a different angle.");
  const updateResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/me/usefulness-feedback/") &&
      response.request().method() === "PATCH"
  );
  await row.getByRole("button", { name: "Save reason" }).click();
  expect((await updateResponse).status()).toBe(200);
  await expect(row).toContainText("I want a different angle.");

  const removeResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/me/usefulness-feedback/") &&
      response.url().endsWith("/undo") &&
      response.request().method() === "POST"
  );
  await row.getByRole("button", { name: "Remove" }).click();
  expect((await removeResponse).status()).toBe(200);
  await expect(row).toHaveCount(0);
});
