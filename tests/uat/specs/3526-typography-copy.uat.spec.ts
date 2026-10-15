import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL } from "../seed/admin.js";

export const uatLevel = { level: "bare", without: [] } as const;

test.use({ trace: "off", screenshot: "off", video: "off" });

async function openSettings(page: Page) {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

async function assertReadableChart(page: Page) {
  const chart = page.getByRole("region", { name: "Mood and medication chart" });
  await expect(chart).toBeVisible();
  const sizes = await chart.locator("svg text").evaluateAll((nodes) =>
    nodes.map((node) => {
      const scale = node instanceof SVGGraphicsElement ? (node.getScreenCTM()?.a ?? 0) : 0;
      return Number.parseFloat(getComputedStyle(node).fontSize) * scale;
    })
  );
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(10.99);
  const dayPicker = page.getByLabel("Inspect a day");
  const latestDay = await dayPicker.locator("option").last().getAttribute("value");
  expect(latestDay).not.toBeNull();
  await dayPicker.selectOption(latestDay!);
  await expect(page.locator(".wl-chart-data").getByRole("status")).toContainText("Medication");
  await expect(page.locator(".wl-chart-data").getByRole("status")).toContainText("happy");
  await page.getByText("View daily values", { exact: true }).click();
  await expect(page.getByRole("table", { name: "Mood and medication observations" })).toBeVisible();
  console.log(
    `TYPOGRAPHY_CHART width=${await page.evaluate(() => innerWidth)} minLabel=${Math.min(...sizes).toFixed(2)}`
  );
}

test("fresh signup, setup, persisted Wellness and installed module copy use real UI paths", async ({
  page
}) => {
  test.setTimeout(540_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!baseURL || !projectName) throw new Error("Disposable UAT stack required");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await test.step("owner signs up and completes setup through the real screens", async () => {
    await page.goto(baseURL);
    await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible({
      timeout: 30_000
    });
    await page.getByLabel("Name", { exact: true }).fill("Typography Owner");
    // The disposable compose stack confirms this identity before module reconciliation on restart.
    await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill("Typography-acceptance-3526!");
    await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Let’s get your Moss set up." })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByText("AI provider", { exact: true })).toBeVisible();
    await expect(page.getByText("Control channel", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Start setup" }).first().click();
    await page.getByRole("button", { name: "Continue", exact: true }).first().click();
    await page
      .getByRole("button", { name: /Skip this step/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Review your setup." })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible({
      timeout: 30_000
    });
    await page.reload();
    await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
    console.log("TYPOGRAPHY_OWNER signup=real setup=completed persistence=reload");
  });

  await test.step("Settings uses semantic headings and Google setup instructions", async () => {
    await openSettings(page);
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Google", exact: true })).toBeVisible();
    await expect(
      page.getByText("Connect Google or an email (IMAP) account using the credentials you provide.")
    ).toBeVisible();
    await page.getByRole("button", { name: "Google", exact: true }).click();
    await expect(
      page.getByText("Create a Google OAuth app, then paste its client ID and secret here.")
    ).toBeVisible();
    await page.getByRole("button", { name: "All accounts", exact: true }).click();
    console.log("TYPOGRAPHY_ACCOUNTS headings=semantic google=real-setup-instructions");
  });

  await test.step("Wellness reads persisted check-in data at desktop and phone sizes", async () => {
    await page
      .locator('nav[aria-label="Main"]')
      .getByRole("link", { name: "Wellness", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Mood and medication", exact: true })
    ).toBeVisible();
    // Create a disposable record through the public API the real Wellness UI reads.
    const saved = await page.request.post(`${baseURL}/api/wellness/checkins`, {
      data: {
        feelingCore: "happy",
        intensity: 3,
        energy: 3,
        sensations: [],
        note: "Typography acceptance check-in"
      }
    });
    expect(saved.status()).toBe(201);
    await page.reload();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await assertReadableChart(page);
      // Close the values table before the next iteration.
      await page.getByText("View daily values", { exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    console.log("TYPOGRAPHY_WELLNESS data=real-api persisted=reload chart=keyboard-readable");
  });

  await test.step("install changed external packages and enable them through Settings", async () => {
    for (const id of ["finance", "food", "job-search"]) {
      execFileSync("pnpm", [`build:external:${id}`], { stdio: "pipe" });
      execFileSync(
        "docker",
        buildUatComposeArgs(projectName, [
          "cp",
          `external-modules/${id}`,
          `jarv1s:/data/modules/${id}`
        ]),
        { stdio: "pipe" }
      );
    }
    await restartUatStack(projectName, baseURL);
    await page.reload();
    await openSettings(page);
    await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
    await page.getByRole("button", { name: "Instance modules", exact: true }).click();
    for (const name of ["Finance", "Food", "Job Search"]) {
      const toggle = page.getByRole("checkbox", { name: `Enable ${name}`, exact: true });
      await expect(page.locator("label.jds-switch", { has: toggle })).toBeVisible();
      await expect(toggle).toBeEnabled();
      if (!(await toggle.isChecked()))
        await page.locator("label.jds-switch", { has: toggle }).click();
      await expect(toggle).toBeChecked();
    }
    await restartUatStack(projectName, baseURL);
    await page.reload();
    console.log(
      "TYPOGRAPHY_MODULES installed=local-built-artifacts enabled=real-admin-ui restart=verified"
    );
  });

  await test.step("Finance and Food render the changed copy through their installed routes", async () => {
    const nav = page.locator('nav[aria-label="Main"]');
    await nav.getByRole("link", { name: "Finance", exact: true }).click();
    await page.getByRole("link", { name: "Finance settings", exact: true }).click();
    const routine = page.getByRole("radio", { name: /Handle routine, ask about new/ });
    await expect(routine).toBeEnabled({ timeout: 30_000 });
    await routine.click({ force: true });
    const limit = page.getByLabel("Maximum per budget move", { exact: true });
    await expect(limit).toBeEnabled({ timeout: 30_000 });
    await limit.fill("125");
    await limit.press("Enter");
    await expect(limit).toHaveValue("$125");
    await page.reload();
    await expect(page.getByLabel("Maximum per budget move", { exact: true })).toHaveValue("$125");
    await nav.getByRole("link", { name: "Food", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nothing logged for this day" })).toBeVisible({
      timeout: 30_000
    });
    await expect(
      page.getByText("Describe what you ate to log a meal.", { exact: false })
    ).toBeVisible();
    console.log("TYPOGRAPHY_EXTERNAL finance-limit=persisted food=real-empty-day");
    expect(errors).toEqual([]);
  });
});
