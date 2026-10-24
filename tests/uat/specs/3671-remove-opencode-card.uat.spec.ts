import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #3671: the separate OpenCode card with its hardcoded chat model dropdown is gone. Adding an
// OpenCode provider through the real Settings screen still works, and the provider shows up as
// a normal provider card with no extra card and no hardcoded model choice anywhere.
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by run-uat.ts`);
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireEnv("JARVIS_UAT_BASE_URL"));
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
}

async function skipOnboardingIfShown(page: Page): Promise<void> {
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    try {
      await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
    } catch {
      // No confirmation dialog on this instance.
    }
  }
  await expect(userMenu).toBeVisible({ timeout: 30_000 });
}

test("OpenCode provider has no separate card or hardcoded model choice (#3671)", async ({
  page
}) => {
  test.setTimeout(180_000);
  const baseURL = requireEnv("JARVIS_UAT_BASE_URL");

  await signIn(page);
  await skipOnboardingIfShown(page);

  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("button", { name: "Add provider" })).toBeVisible({
    timeout: 30_000
  });

  // Add the OpenCode CLI provider through the real catalog.
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();

  // The provider itself is still there as a normal provider card.
  const card = page.locator(".prov").filter({ has: page.getByLabel("Remove OpenCode") });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Connected");

  // No separate OpenCode ACP card and no hardcoded model dropdown.
  await expect(page.getByLabel("OpenCode ACP provider")).toHaveCount(0);
  await expect(page.getByText("Muse Spark 1.3 free")).toHaveCount(0);
  await expect(page.getByText("Login default")).toHaveCount(0);
  await expect(page.getByText("OpenCode uses the ACP chat path", { exact: false })).toHaveCount(0);

  // The real chat settings answer carries no hardcoded OpenCode model choice.
  const response = await page.request.get(`${baseURL}/api/chat/settings`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { chat: Record<string, unknown> };
  expect(body.chat).not.toHaveProperty("openCodeModel");
});
