import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withSportsPublicSourceFixtures: true
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
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

async function openStoryMenu(page: Page): Promise<void> {
  await page.goto(`${requireBaseURL()}/sports`);
  const trigger = page.getByRole("button", { name: "Story feedback" }).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "More like this" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("saves Sports story feedback and keeps the story visible", async ({ page }) => {
  await signIn(page);
  await openStoryMenu(page);
  await page.getByRole("menuitem", { name: "More like this" }).click();
  await expect(page.getByRole("status", { name: "Saved" })).toBeVisible();

  await page.goto(`${requireBaseURL()}/today`);
  await expect(page.getByRole("button", { name: "Story feedback" }).first()).toBeVisible();
});

test("edits and removes a Less like this preference in Sports Settings", async ({ page }) => {
  await signIn(page);
  await openStoryMenu(page);
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  const editor = page.getByRole("dialog", { name: "Why less like this?" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Tell us why before saving.")).toBeVisible();
  await editor
    .getByRole("textbox", { name: "Why less like this?" })
    .fill("Too much of this coverage");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const preferences = page.locator('section[aria-label="Story preferences"]');
  await expect(preferences).toBeVisible();
  await expect(preferences).toContainText("Less like this");
  await expect(preferences).toContainText("Too much of this coverage");

  const row = preferences
    .locator(".sp-feedback-settings__row")
    .filter({ hasText: "Too much of this coverage" });
  await row.getByRole("button", { name: "Edit reason" }).click();
  const reason = row.getByRole("textbox", { name: /Reason for/ });
  await reason.fill("Updated Sports reason");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Updated Sports reason");
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
});
