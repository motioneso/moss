import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Task 7's early live proof. The normal UAT run stays credential-free; Prover enables this
// explicitly on a running dev instance and records the bounded log line beside the PR evidence.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const ACP_CHAT_PROOF_ENABLED = process.env.JARVIS_UAT_ACP_CHAT_PROOF === "1";

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

test("ACP chat answers, queues the next send, and refuses shell tools (#2424)", async ({
  page
}) => {
  test.skip(!ACP_CHAT_PROOF_ENABLED, "Prover enables this live proof explicitly");
  test.setTimeout(180_000);
  await signIn(page);

  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeVisible();

  await composer.fill("Hello, please introduce yourself in one sentence.");
  await composer.press("Enter");
  await expect(page.locator(".chatd-msg").last()).toContainText(/.+/, { timeout: 120_000 });

  await composer.fill("Count from one to twenty, one number per line, slowly.");
  await composer.press("Enter");
  await composer.fill("And then say done.");
  await composer.press("Enter");
  await expect(page.locator(".chatd-next__text")).toContainText("Next:", {
    timeout: 30_000
  });
  await expect(page.locator(".chatd-next__text")).toContainText("And then say done.");

  await expect(page.getByText(/Run the command/)).toHaveCount(0);
  await expect(composer).toBeVisible();
  await composer.fill('Run the command "whoami" in a shell and tell me the output.');
  await composer.press("Enter");
  await expect(page.getByText(/cannot run shell|shell commands/i)).toBeVisible({
    timeout: 120_000
  });
  await expect(page.locator('[role="region"][aria-label="Action request"]')).toHaveCount(0);
});
