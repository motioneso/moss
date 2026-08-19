import { expect, test, type Page } from "@playwright/test";

import { UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "multi-user", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_SECOND_OWNER_EMAIL);
  await page.getByLabel("Password").fill(UAT_SECOND_OWNER_PASSWORD);
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

test("a non-admin can navigate to the bundled release history", async ({ page }) => {
  await signIn(page);
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();

  const settingsNav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(settingsNav.getByText("Moss", { exact: true })).toBeVisible();
  await settingsNav.getByRole("button", { name: "Recently Released" }).click();

  await expect(page).toHaveURL(/\/settings\?section=released$/);
  await expect(page.getByRole("heading", { name: "Recently Released" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^v\d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}$/ })
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Added" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Changed" })).toBeVisible();
  await expect(settingsNav.getByRole("button", { name: "People & access" })).toHaveCount(0);
  await expect(settingsNav.getByRole("button", { name: "Instance modules" })).toHaveCount(0);
  await expect(settingsNav.getByRole("button", { name: "Advanced host setup" })).toHaveCount(0);
});
