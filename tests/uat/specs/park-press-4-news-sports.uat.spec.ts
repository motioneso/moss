import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Park Press check 4 (PR 3348): News and Sports entry, genuine read failure and retry, and the
// wrapped Sports standings picker. Read failures are created by really stopping the app
// container while the already-loaded page stays open; nothing Moss sends is rewritten.
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

async function composeApp(action: "stop" | "start"): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(uatProject(), [action, "postgres"]), {
    maxBuffer: 1_000_000
  });
  console.log(`[check4] app container ${action} done`);
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

function mainNav(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });
}

test("News and Sports: entry, genuine read failure, retry (LN08, LN09)", async ({
  page,
  context
}) => {
  test.setTimeout(420_000);
  await signIn(page);

  // Warm the browser's file cache with the Sports screen code in a throwaway tab, so the
  // tab under test has no cached Sports data but can still open the screen with the app down.
  const warm = await context.newPage();
  await warm.goto(`${baseURL()}/sports`);
  await expect(warm.getByRole("button", { name: "Select standings league" })).toBeVisible({
    timeout: 60_000
  });
  await warm.close();
  await page.goto(`${baseURL()}/news`);

  // Real entry through the Main navigation. News is loaded first and so is cached afterwards.
  await mainNav(page, "News").click();
  await expect(page).toHaveURL(/\/news$/);
  await expect(page.getByText("News is unavailable right now.")).toHaveCount(0);
  await expect(page.locator(".nw-wrap article, .nw-wrap a[href^='http']").first()).toBeVisible({
    timeout: 30_000
  });

  // Sports has not been opened yet, so it has nothing cached. Stop the app, then open it.
  await composeApp("stop");
  try {
    await mainNav(page, "Sports").click();
    const unavailable = page
      .getByRole("status")
      .filter({ hasText: "Sports are unavailable right now." });
    await expect(unavailable).toBeVisible({ timeout: 60_000 });
    await expect(unavailable.getByRole("button", { name: "Try again" })).toBeVisible();
  } finally {
    await composeApp("start");
  }
  await waitHealthy(page);
  const retry = page
    .getByRole("status")
    .filter({ hasText: "Sports are unavailable right now." })
    .getByRole("button", { name: "Try again" });
  await retry.click();
  await expect(page.getByText("Sports are unavailable right now.")).toHaveCount(0, {
    timeout: 60_000
  });
  await expect(page.getByRole("button", { name: "Select standings league" })).toBeVisible({
    timeout: 30_000
  });
  console.log("[check4] Sports first-load failure shown, retry recovered");

  // News has cached data: a failed refresh keeps the front page and offers Try again.
  await composeApp("stop");
  try {
    await mainNav(page, "News").click();
    const stale = page.getByRole("status").filter({ hasText: "Could not refresh news." });
    await expect(stale).toBeVisible({ timeout: 60_000 });
    await expect(stale.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator(".nw-wrap article, .nw-wrap a[href^='http']").first()).toBeVisible();
  } finally {
    await composeApp("start");
  }
  await waitHealthy(page);
  await page
    .getByRole("status")
    .filter({ hasText: "Could not refresh news." })
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(page.getByText("Could not refresh news.")).toHaveCount(0, { timeout: 60_000 });
  console.log("[check4] News stale-refresh failure shown with front page kept, retry recovered");
});

for (const width of [320, 390, 1440]) {
  test(`Sports standings picker at ${width}px: open, select, back, Escape, focus (LN10)`, async ({
    page
  }) => {
    test.setTimeout(240_000);
    // Sign in at desktop width, where the account menu is always visible, then narrow.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await signIn(page);
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`${baseURL()}/sports`);
    const trigger = page.getByRole("button", { name: "Select standings league" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    const nav = page.locator(".sp-standings__nav");

    for (const edge of ["natural", "start", "end"] as const) {
      if (edge !== "natural") {
        // Layout-only stress of the two header edges; no network response is touched.
        await page.addStyleTag({
          content: `
            .sp-standings__nav { flex-basis: 100%; width: 100%; justify-content: ${edge === "start" ? "flex-start" : "flex-end"}; flex-direction: ${edge === "start" ? "row" : "row-reverse"}; }
            .sp-standings-picker { margin-left: ${edge === "start" ? "0" : "auto"}; margin-right: ${edge === "start" ? "auto" : "0"}; }
          `
        });
      }
      await trigger.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const navBox = (await nav.boundingBox())!;
      const trigBox = (await trigger.boundingBox())!;
      console.log(
        `[check4] width=${width} edge=${edge} nav.x=${Math.round(navBox.x)} nav.w=${Math.round(navBox.width)} trigger.x=${Math.round(trigBox.x)} trigger.w=${Math.round(trigBox.width)}`
      );

      await trigger.focus();
      await trigger.press("Enter");
      const menu = page.getByRole("menu", { name: "Standings leagues" });
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x, `menu left edge at ${width}/${edge}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `menu right edge at ${width}/${edge}`).toBeLessThanOrEqual(width);
      const choices = menu.locator('[role="menuitem"], [role="menuitemradio"]');
      expect(await choices.count()).toBeGreaterThan(0);
      for (const choice of await choices.all()) {
        const label = (await choice.textContent())?.trim();
        const hit = await choice.evaluate((element) => {
          element.scrollIntoView({ block: "nearest" });
          const rect = element.getBoundingClientRect();
          const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return top !== null && element.contains(top);
        });
        expect(hit, `choice "${label}" reachable`).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );

      // Descend into a sport, then Back, then Escape: focus returns to the opener.
      const sport = menu.getByRole("menuitem").first();
      const sportName = (await sport.textContent())?.trim();
      await sport.focus();
      await sport.press("Enter");
      const back = menu.getByRole("menuitem", { name: /back/i }).first();
      await expect(back, `Back row after opening ${sportName}`).toBeVisible();
      await back.focus();
      await back.press("Enter");
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // Select a league from the root list and confirm the opener gets focus back.
      await trigger.press("Enter");
      await expect(menu).toBeVisible();
      const league = menu.getByRole("menuitemradio").first();
      await league.focus();
      await league.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    console.log(`[check4] picker checks done at ${width}px`);
  });
}
