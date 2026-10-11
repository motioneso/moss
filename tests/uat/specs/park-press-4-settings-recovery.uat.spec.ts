import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Park Press check 4 (PR 3348), LN11 settings portion: Email and Wellness settings tell a read
// failure from a save failure, keep the last confirmed choice after a failed save, and recover
// by retry after restart. Failures are real: the database container is stopped.
export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT target");
  return project;
}

async function composeDb(action: "stop" | "start"): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(uatProject(), [action, "postgres"]), {
    maxBuffer: 1_000_000
  });
  console.log(`[check4] database ${action} done`);
}

async function waitHealthy(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get(`${baseURL()}/health/ready`, { timeout: 3000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 120_000, intervals: [1000] }
    )
    .toBe(200);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

// Moves inside the running app without a page load, so the settings code is already in the tab.
async function spaGo(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

interface Case {
  readonly name: string;
  readonly module: string;
  readonly control: string;
  readonly readFail: string;
  readonly saveFail: string;
}

const CASES: readonly Case[] = [
  {
    name: "Wellness",
    module: "wellness",
    control: "Allow your assistant to read your wellness data",
    readFail: "Could not load Wellness AI access.",
    saveFail: "Could not save Wellness AI access. Try again."
  },
  {
    name: "Email",
    module: "email",
    control: "Include email signal in briefings",
    readFail: "Could not load email settings.",
    saveFail: "Could not save email settings. Try again."
  }
];

for (const c of CASES) {
  test(`${c.name} settings: read failure, failed save keeps the choice, retry, reload (LN11)`, async ({
    page,
    context
  }) => {
    test.setTimeout(420_000);
    await signIn(page);
    const url = `/settings?section=modules&module=${c.module}`;

    // Warm the file cache for the settings code in a throwaway tab.
    const warm = await context.newPage();
    await warm.goto(`${baseURL()}${url}`);
    await expect(warm.getByLabel(c.control, { exact: true })).toBeAttached({ timeout: 60_000 });
    await warm.close();

    // 1. Read failure: no cached value, database down, so the pane says it could not load.
    await page.goto(`${baseURL()}/settings?section=modules`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(/Loading Moss/)).toHaveCount(0, { timeout: 60_000 });
    await composeDb("stop");
    try {
      await spaGo(page, url);
      await page.waitForTimeout(3000);
      console.log(
        `[check4] ${c.name}: page text with database down: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`
      );
      const readStatus = page.getByRole("status").filter({ hasText: c.readFail });
      await expect(readStatus).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.getByText(c.saveFail)).toHaveCount(0);
      await expect(page.getByLabel(c.control, { exact: true })).toHaveCount(0);
      console.log(`[check4] ${c.name}: read failure shown, no control, no save error`);
    } finally {
      await composeDb("start");
    }
    await waitHealthy(page);
    await page.getByRole("button", { name: "Try again" }).click();
    const control = page.getByLabel(c.control, { exact: true });
    await expect(control).toBeAttached({ timeout: 60_000 });
    const confirmed = await control.isChecked();
    console.log(`[check4] ${c.name}: retry loaded control, confirmed=${confirmed}`);

    // 2. Failed save: the shown choice stays the confirmed one, and the error is a save error.
    const toggle = page.locator("label", { has: control });
    await composeDb("stop");
    try {
      await toggle.click();
      await expect(page.getByRole("alert").filter({ hasText: c.saveFail })).toBeVisible({
        timeout: 60_000
      });
      await expect(page.getByText(c.readFail)).toHaveCount(0);
      expect(await control.isChecked()).toBe(confirmed);
      console.log(`[check4] ${c.name}: save failure shown, choice kept at ${confirmed}`);
    } finally {
      await composeDb("start");
    }
    await waitHealthy(page);

    // 3. Retry after restart saves, and a reload shows the persisted value.
    await toggle.click();
    await expect(page.getByRole("alert").filter({ hasText: c.saveFail })).toHaveCount(0, {
      timeout: 60_000
    });
    await expect.poll(() => control.isChecked(), { timeout: 30_000 }).toBe(!confirmed);
    await page.reload();
    await expect(page.getByLabel(c.control, { exact: true })).toBeAttached({ timeout: 60_000 });
    expect(await page.getByLabel(c.control, { exact: true }).isChecked()).toBe(!confirmed);
    console.log(`[check4] ${c.name}: after reload persisted=${!confirmed}`);
  });
}
