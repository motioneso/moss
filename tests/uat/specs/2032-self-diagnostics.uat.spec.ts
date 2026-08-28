import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseUrl());
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

test("the live server advertises both self-diagnostics tools", async ({ page }) => {
  await signIn(page);
  const response = await page.request.get(`${baseUrl()}/api/ai/assistant-tools`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { tools?: Array<{ name?: string; risk?: string }> };
  const tools = body.tools ?? [];
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "settings.platformDiagnostics", risk: "read" }),
      expect.objectContaining({ name: "news.refreshNews", risk: "write" })
    ])
  );
});

// The default UAT environment has no instruction-following chat model. Keep the required live
// conversation proof explicit rather than pretending a manifest request proves diagnosis,
// confirmation, queued work, and the later freshness check.
test.fixme("a real Moss conversation diagnoses, refreshes, and rechecks news", async () => {});
