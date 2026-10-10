import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #3187: the parts of Finance phase 3 that need no bank and no chat model, proven on a real
// instance. The Settings screen saves the freedom step and the dollar limit, a budget amount
// typed on the Budget screen shows in the Settings activity list, and Undo puts the amount
// back. The chat half (Moss moving money, the approval card) lives in
// 3187-finance-r1-freedom-moves.uat.spec.ts, which needs a signed-in model and Plaid keys.
//
// Nothing in the browser is intercepted or rewritten. The seed plants only the Finance
// rows in module storage (see finance-budget.uat.spec.ts); no credential exists in the stack.
export const uatLevel = { level: "admin+data", without: [] } as const;

const PROOF_DIR = process.env.FIN_3187_PROOF_DIR ?? "/tmp/fin-3187-proof";

async function crop(target: Locator, name: string): Promise<void> {
  mkdirSync(PROOF_DIR, { recursive: true });
  await target.screenshot({ path: join(PROOF_DIR, `${name}.png`) });
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (testInfo.status === testInfo.expectedStatus || !projectName) return;
  try {
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "3000", "jarv1s"]),
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    console.log(
      logs
        .split("\n")
        .filter((line) => !line.includes('"msg":"incoming request"') && !line.includes("completed"))
        .join("\n")
    );
  } catch {
    // diagnostics only
  }
});

test("Finance Settings saves the step and limit, lists activity, and undoes it", async ({
  page
}) => {
  test.setTimeout(420_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "cp",
      "external-modules/finance",
      "jarv1s:/data/modules/finance"
    ]),
    { stdio: "inherit" }
  );
  await restartUatStack(projectName, baseURL);

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(userMenu).toBeVisible();

  await userMenu.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  const enableSwitch = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await expect(enableSwitch).not.toBeChecked();
  await page.locator("label.jds-switch", { has: enableSwitch }).click();
  await expect(enableSwitch).toBeChecked();
  await restartUatStack(projectName, baseURL);
  await page.reload();

  const views = page.locator('[aria-label="Finance views"]');
  const settings = page.locator('section[aria-label="Finance settings"]');
  const budget = page.locator('section[aria-label="Budget"]');
  const openFinance = async () => {
    await page.goto(baseURL);
    await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
    await expect(views).toBeVisible({ timeout: 30_000 });
  };
  const openSettings = async () => {
    await openFinance();
    await page.getByRole("link", { name: "Finance settings" }).click();
    await expect(settings).toBeVisible({ timeout: 30_000 });
  };

  // --- Step and limit survive a reload -------------------------------------------------------
  await openSettings();
  await expect(
    settings.getByText("Moss hasn't done anything on its own yet.").locator("visible=true").first()
  ).toBeVisible({ timeout: 30_000 });
  await crop(settings, "settings-fresh");
  await settings
    .getByRole("radio", { name: /Handle routine, ask about new/ })
    .check({ force: true });
  const limitBox = settings.getByLabel("Moss can move up to, per move");
  await limitBox.fill("100");
  await limitBox.press("Enter");
  await expect(async () => {
    await openSettings();
    await expect(
      settings.getByRole("radio", { name: /Handle routine, ask about new/ })
    ).toBeChecked({ timeout: 5_000 });
    await expect(settings.getByLabel("Moss can move up to, per move")).toHaveValue("$100", {
      timeout: 5_000
    });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
  await crop(settings, "settings-step-2-limit-100");

  // --- A typed budget amount shows in the activity list --------------------------------------
  await openFinance();
  await views.getByText("Budget", { exact: true }).click();
  await expect(budget).toBeVisible({ timeout: 30_000 });
  const groceries = budget.getByLabel("Assigned to Groceries").locator("visible=true").first();
  await groceries.click();
  await groceries.press("Control+a");
  await groceries.pressSequentially("50");
  await groceries.press("Enter");
  const row = settings
    .locator(".fnm-switch-row", { hasText: /Set Groceries to \$50(\.00)?/ })
    .locator("visible=true")
    .first();
  await expect(async () => {
    await openSettings();
    await expect(row).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000, intervals: [3_000] });
  await expect(row).toContainText("You");
  await crop(settings, "settings-activity-after-assign");

  // --- Undo restores the old amount ----------------------------------------------------------
  await row.getByRole("button", { name: "Undo" }).click();
  await expect(row).toContainText("Undone", { timeout: 60_000 });
  await crop(settings, "settings-activity-after-undo");
  await expect(async () => {
    await openFinance();
    await views.getByText("Budget", { exact: true }).click();
    await expect(
      budget.getByLabel("Assigned to Groceries").locator("visible=true").first()
    ).toHaveValue("$0.00", { timeout: 5_000 });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
});
