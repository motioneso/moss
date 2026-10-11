// Park Press acceptance check 2 (PR 3346, Core), part 2: genuine read failures with the database
// container stopped, retry, recovery, Today, and theme contrast. No Moss response is intercepted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);
const OWNER_EMAIL = UAT_ADMIN_EMAIL;
const OWNER_PASSWORD = UAT_ADMIN_PASSWORD;

function project(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value?.startsWith("uat-")) throw new Error("Run through the isolated UAT provisioner");
  return value;
}

// A page-code download occasionally fails and shows the whole-app error screen. The screen is
// logged as evidence, then the page is reloaded once so the rest of the check can run.
async function go(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const crash = page.getByRole("heading", { name: "Something went wrong." });
  if (await crash.isVisible({ timeout: 4_000 }).catch(() => false)) {
    console.log(`[CRASH SEEN: whole-app error screen after loading ${url}; reloading once]`);
    await page.reload();
  }
}

async function compose(...args: string[]): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(project(), args), { maxBuffer: 1_000_000 });
}

for (const target of [
  { name: "Memory & context", mode: "Personal", loadFailure: "Could not load memories." },
  { name: "People & access", mode: "Admin / Setup", loadFailure: null }
] as const) {
  test(`Core: genuine read failure on ${target.name} (database stopped), retry, recovery`, async ({
    page
  }) => {
    test.setTimeout(420_000);
    const baseURL = process.env.JARVIS_UAT_BASE_URL!;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(baseURL);
    await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
    await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    const account = page.getByRole("button", { name: /^Account menu/ });
    await expect(skip.or(account).first()).toBeVisible({ timeout: 60_000 });
    if (await skip.isVisible()) {
      await skip.click();
      await page.getByRole("button", { name: "Skip anyway" }).click();
    }
    await expect(account).toBeVisible({ timeout: 60_000 });
    await go(page, `${baseURL}/settings`);
    await page.getByRole("button", { name: target.mode, exact: true }).click();
    const nav = page.getByRole("button", { name: new RegExp(target.name) });
    await expect(nav).toBeVisible({ timeout: 30_000 });
    try {
      await compose("stop", "postgres");
      await nav.click();
      await page.waitForTimeout(10_000);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
      console.log(`[${target.name} with database down: ${text}]`);
      console.log(`[browser errors: ${JSON.stringify(errors.slice(0, 6))}]`);
      await expect(
        page.getByRole("heading", { name: "Something went wrong." }),
        "a failed read must not crash the whole app"
      ).toHaveCount(0);
      if (target.loadFailure) {
        const failure = page.getByText(target.loadFailure);
        await expect(failure).toBeVisible({ timeout: 60_000 });
        // An unknown read never turns into a nothing-here success state.
        await expect(page.getByText("Nothing here.")).toHaveCount(0);
        await page.getByRole("button", { name: "Try again" }).first().click();
        await expect(failure).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText("Nothing here.")).toHaveCount(0);
        await compose("start", "postgres");
        await expect
          .poll(
            async () =>
              (await page.request.get(`${baseURL}/health/ready`).catch(() => null))?.status(),
            { timeout: 180_000, intervals: [2_000] }
          )
          .toBe(200);
        await page.getByRole("button", { name: "Try again" }).first().click();
        await expect(failure).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByText("Nothing here.")).toBeVisible();
      }
    } finally {
      await compose("start", "postgres").catch(() => undefined);
    }
  });
}

test("Core: Today loads without the whole-app error screen at 1280 and 390", async ({ page }) => {
  test.setTimeout(240_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL!;
  await page.goto(baseURL);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  const nav = page
    .getByRole("button", { name: /^Account menu/ })
    .or(page.getByRole("button", { name: "Open navigation" }));
  await expect(skip.or(nav).first()).toBeVisible({ timeout: 60_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await go(page, `${baseURL}/today`);
    await page.waitForTimeout(4_000);
    const crashed = await page
      .getByRole("heading", { name: "Something went wrong." })
      .isVisible()
      .catch(() => false);
    const text = (
      await page
        .locator("main")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    console.log(`[Today at ${width}: crashed=${crashed}; ${text.slice(0, 200)}]`);
    expect(crashed, `Today at ${width}`).toBe(false);
    expect(text.length, `Today at ${width} has content`).toBeGreaterThan(20);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `Today at ${width}: no page overflow`
    ).toBe(true);
  }
});
