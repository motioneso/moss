import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

// #2842: a second admin must see the model list of a provider another admin set up. The first
// admin adds a provider through Settings; the second account is made an admin on the host, then
// signs in through the real login screen and opens the same Settings card.
export const uatLevel = { level: "multi-user", without: [] } as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by run-uat.ts`);
  return value;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(requireEnv("JARVIS_UAT_BASE_URL"));
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
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

async function openAssistantAndAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test("a second admin sees the models of a provider another admin added (#2842)", async ({
  browser,
  page
}) => {
  test.setTimeout(180_000);
  const projectName = requireEnv("JARVIS_UAT_PROJECT_NAME");

  // --- Admin one adds a provider through the real Settings screen.
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  await skipOnboardingIfShown(page);
  await openAssistantAndAiSettings(page);
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  const ownerCard = page.locator(".prov").filter({ has: page.getByLabel("Remove Anthropic") });
  // No provider CLI on this stack, so nothing is discovered; admin one types a model in by hand.
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).click();
  await ownerCard.getByLabel("Model id").fill("uat-shared-model");
  await ownerCard.getByLabel("Display name").fill("UAT Shared Model");
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).last().click();
  await expect(ownerCard.locator(".mdl__id", { hasText: "uat-shared-model" })).toBeVisible({
    timeout: 30_000
  });
  const ownerModelCount = await ownerCard.locator(".mdl__id").count();
  await shot(page, "01-admin-one-provider-models");

  // --- Host side: the second account becomes an admin (no screen promotes users here).
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-c",
      `UPDATE app.users SET is_instance_admin = true WHERE email = '${UAT_SECOND_OWNER_EMAIL}'`
    ]),
    { stdio: "inherit" }
  );

  // --- Admin two signs in in a separate browser session and opens the same card.
  const context = await browser.newContext();
  const second = await context.newPage();
  try {
    await signIn(second, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
    await skipOnboardingIfShown(second);
    await openAssistantAndAiSettings(second);

    const card = second.locator(".prov").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const header = card.getByRole("button", { name: /^Models · \d+/ });
    await expect(header).toBeVisible();
    await header.click();
    // The model id line is blank when the screen hides ids from a non-owner.
    await expect(card.locator(".mdl__id", { hasText: "uat-shared-model" })).toBeVisible({
      timeout: 30_000
    });
    expect(await card.locator(".mdl__id").count()).toBe(ownerModelCount);
    await shot(second, "02-admin-two-sees-model-ids");

    // Refresh works for the second admin and keeps the list on screen.
    const refreshed = second.waitForResponse(
      (r) => r.url().includes("/models/refresh") && r.request().method() === "POST"
    );
    await card.getByRole("button", { name: "Refresh models" }).click();
    expect((await refreshed).status()).toBe(200);
    await expect(card.locator(".mdl__id", { hasText: "uat-shared-model" })).toBeVisible();
    await shot(second, "03-admin-two-after-refresh");
  } finally {
    await context.close();
  }
});
