import { expect, test, type Locator, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: ["sports"],
  withSportsPublicSourceFixtures: true
} as const;

const SOURCE_LABEL = "FotMob assignment fixture";
const FEED_URL = "https://www.fotmob.com/topnews/feed?format=atom";

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

async function openSource(page: Page): Promise<Locator> {
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const section = page.locator('section[aria-label="Sports news sources"]');
  await expect(section).toBeVisible();
  const source = section.locator(".sp-src__item").filter({ hasText: SOURCE_LABEL });
  await expect(source).toBeVisible();
  return source;
}

test("adds Soccer to a legacy feed while preserving compact assigned identities", async ({
  page
}) => {
  await signIn(page);
  let source = await openSource(page);

  await expect(source).toContainText("All Premier League");
  await expect(source).toContainText("Arsenal");
  await expect(source).toContainText("All NFL");
  await expect(source).not.toContainText(FEED_URL);
  const logo = source.locator("img.sp-src__assignment-logo").first();
  await expect(logo).toHaveAttribute("alt", "");
  await expect(logo).toHaveAttribute("aria-hidden", "true");

  await source.getByRole("button", { name: `Edit coverage for ${SOURCE_LABEL}` }).click();
  await expect(source).not.toContainText(FEED_URL);
  await source.getByRole("group", { name: "Sports" }).getByText("Soccer", { exact: true }).click();
  await source.getByRole("button", { name: "Review changes" }).click();

  const preview = source.locator(".sp-src__candidate");
  await expect(preview.locator(".sp-src__assignment-identity")).toHaveCount(4);
  await expect(preview).toContainText("Premier League");
  await expect(preview).toContainText("Arsenal");
  await expect(preview).toContainText("NFL");
  await expect(preview).toContainText("Soccer");
  await expect(preview).not.toContainText(FEED_URL);
  await preview.locator("label.jds-check").click();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await preview.getByRole("button", { name: "Save assignments" }).click();
  await expect(source).toContainText("Soccer");

  source = await openSource(page);
  await expect(source).toContainText("All Premier League");
  await expect(source).toContainText("Arsenal");
  await expect(source).toContainText("All NFL");
  await expect(source).toContainText("Soccer");
  await expect(source).not.toContainText(FEED_URL);
});
