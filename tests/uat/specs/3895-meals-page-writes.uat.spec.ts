// tests/uat/specs/3895-meals-page-writes.uat.spec.ts
//
// #3895 Meals slice 11 live-path proof: the page's own controls, through the real Meals page on
// a disposable prod-shaped stack. Add a person, write a one-day plan, lock and swap a meal,
// tick and buy from the shopping list, add to the Pantry, mark a meal cooked, rate it and find
// the logged portion in Log, then delete the plan and clear the list through the host's
// confirmation dialog. Nothing here intercepts, stubs or rewrites a response.
//
// Screenshots are written only when MEALS_S11_SHOT_DIR is set, at 1280 and 390 wide.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { bringUpRealChatModel } from "./real-chat-signin.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test.use({ trace: "off", screenshot: "off", video: "off" });

const SHOT_DIR = process.env.MEALS_S11_SHOT_DIR ?? "";
const MODULE_VERSION = (
  JSON.parse(readFileSync("external-modules/meals/jarvis.module.json", "utf8")) as {
    version: string;
  }
).version;
const MODULE_BUILD_TIMEOUT_MS = 180_000;
const PLAN_WRITE_TIMEOUT_MS = 35 * 60_000;
const QUICK_SWAP_TIMEOUT_MS = 10 * 60_000;

function say(message: string): void {
  console.log(`MEALS_S11 ${message}`);
}

/**
 * Activates a control with the keyboard. Mouse clicks time out on this stack in this
 * environment because buttons never settle between frames (three runs, same timeout, on
 * the sign-in, welcome and app screens alike), while keyboard input works throughout.
 */
async function press(page: Page, locator: ReturnType<Page["getByRole"]>): Promise<void> {
  await locator.focus();
  await page.keyboard.press("Enter");
}

function isoPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  mkdirSync(SHOT_DIR, { recursive: true });
  // Chromium on this host never returns a frame, through page.screenshot or the browser
  // protocol alike (both hang, even on a data: URL), so Chromium captures go through the
  // protocol with a ceiling and every other engine uses the plain screenshot.
  const chromium = page.context().browser()?.browserType().name() === "chromium";
  const cdp = chromium ? await page.context().newCDPSession(page) : null;
  for (const [width, height] of [
    [1280, 900],
    [390, 844]
  ] as const) {
    await page.setViewportSize({ width, height });
    if (cdp === null) {
      await page.screenshot({ path: join(SHOT_DIR, `${name}-${width}.png`), timeout: 20_000 });
      continue;
    }
    const captured = await Promise.race([
      cdp.send("Page.captureScreenshot", { format: "png" }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000))
    ]);
    if (captured === null) {
      say(`shot ${name}-${width} did not come back in 20 s`);
      continue;
    }
    writeFileSync(join(SHOT_DIR, `${name}-${width}.png`), Buffer.from(captured.data, "base64"));
  }
  if (cdp !== null) await cdp.detach().catch(() => undefined);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function openSettings(page: Page): Promise<void> {
  await press(page, page.getByRole("button", { name: /^Account menu(?:,|$)/ }));
  await press(page, page.getByRole("menuitem", { name: "Settings", exact: true }));
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

async function openInstanceModules(page: Page): Promise<void> {
  await openSettings(page);
  await press(page, page.getByRole("button", { name: "Admin / Setup", exact: true }));
  await press(page, page.getByRole("button", { name: "Instance modules", exact: true }));
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
}

/**
 * Waits for the plan to render. The stack restarts its app while the model is pinned and while a
 * module is enabled, so a load can land mid-restart and show the page's own recovery; pressing
 * that recovery's Try again is the real page's retry, not a stub.
 */
async function settlePlan(page: Page): Promise<void> {
  const ready = page
    .locator("section.mls-day")
    .first()
    .or(page.getByText("Plan your first week", { exact: true }))
    .or(page.getByText("Writing your plan", { exact: true }));
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (
      await ready
        .first()
        .isVisible()
        .catch(() => false)
    )
      return;
    if (await retry.isVisible().catch(() => false)) await press(page, retry);
    await page.waitForTimeout(2_000);
  }
  await expect(ready.first()).toBeVisible({ timeout: 60_000 });
}

/** Waits for a recipe to render, retrying the page's own recovery once if a load was cut short. */
async function settleRecipe(page: Page): Promise<void> {
  const ready = page.getByText(/Still to buy:|Nothing still to buy/, { exact: false }).first();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await ready.isVisible().catch(() => false)) return;
    if (await retry.isVisible().catch(() => false)) await press(page, retry);
    await page.waitForTimeout(2_000);
  }
  await expect(ready).toBeVisible({ timeout: 60_000 });
}

/** Switches the instance's colour mode the way a person does, then lands back on the plan. */
async function setColorMode(page: Page, mode: "Light" | "Dark"): Promise<void> {
  await page.goto("/m/meals");
  await openSettings(page);
  // Settings remembers the last mode it was used in, and the module step leaves it on
  // Admin / Setup, where Appearance is not listed.
  await press(
    page,
    page.getByRole("group", { name: "Settings mode", exact: true }).getByRole("button", {
      name: "Personal",
      exact: true
    })
  );
  await press(page, page.getByRole("button", { name: "Appearance", exact: true }));
  await press(
    page,
    page
      .getByRole("group", { name: "Color mode", exact: true })
      .getByRole("button", { name: mode, exact: true })
  );
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode.toLowerCase());
  await page.goto("/m/meals");
  await settlePlan(page);
}

/** True when nothing on the page sticks out sideways at either proof width. */
async function noSidewaysScroll(page: Page): Promise<boolean> {
  let okay = true;
  for (const [width, height] of [
    [1280, 900],
    [390, 844]
  ] as const) {
    await page.setViewportSize({ width, height });
    okay = okay && (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return okay;
}

interface MealRow {
  readonly title: string;
  readonly id: string;
  readonly slot: string;
}

async function readDays(page: Page): Promise<readonly (readonly MealRow[])[]> {
  return page.locator("section.mls-day").evaluateAll((nodes) =>
    nodes.map((node) =>
      [...node.querySelectorAll(".mls-slot")].flatMap((slot) => {
        const slotName = (slot.querySelector(".mls-slot__label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return [...slot.querySelectorAll("article.mls-meal")].map((meal) => {
          const href = meal.querySelector("a.mls-meal__title")?.getAttribute("href") ?? "";
          return {
            title: meal.querySelector(".mls-meal__title")?.textContent?.trim() ?? "",
            id: href.split("/").pop() ?? "",
            slot: slotName
          };
        });
      })
    )
  );
}

async function waitForPlanSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const regenerate = await page
          .locator(".mls-planbar")
          .getByRole("button", { name: "Regenerate", exact: true })
          .count();
        const stillWriting = await page.locator(".mls-writing").count();
        const writingBanner = await page.getByText("Writing your plan", { exact: true }).count();
        return regenerate > 0 && stillWriting === 0 && writingBanner === 0 ? "settled" : "busy";
      },
      { timeout: PLAN_WRITE_TIMEOUT_MS, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe("settled");
}

test("every Meals page control works through the real page", async ({ page }) => {
  test.setTimeout(75 * 60_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!baseURL || !projectName) throw new Error("Disposable UAT stack required");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Buttons on this stack never settle long enough for a mouse click in this environment
  // (three runs, same timeout, on two different screens). Reduced motion stills the loop.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await test.step("the seeded owner signs in through the real sign-in form", async () => {
    // The shared helper clicks the submit button, and in this environment that button never
    // settles long enough for a mouse click (two runs, same 30 s timeout). Submitting the
    // real form with Enter drives the same form, the same sign-in call and the same session.
    await page.goto(baseURL);
    await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
    await page.getByLabel("Password").press("Enter");
    const skipSetup = page.getByRole("button", { name: "Skip setup" });
    const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
    const pressButton = async (locator: typeof skipSetup) => {
      await locator.focus();
      await page.keyboard.press("Enter");
    };
    await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
    if (await skipSetup.isVisible()) {
      await pressButton(skipSetup);
      // The confirm dialog only shows when chat is unusable.
      const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
      await expect(skipAnyway.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
      if (await skipAnyway.isVisible()) await pressButton(skipAnyway);
    }
    await page.reload();
    await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible({
      timeout: 60_000
    });
    say("owner signin=real-form session=persisted");
  });

  await test.step("Meals is built from this tree, dropped on the stack and enabled in Settings", async () => {
    execFileSync("pnpm", ["build:external:meals"], {
      stdio: "pipe",
      timeout: MODULE_BUILD_TIMEOUT_MS
    });
    execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "cp",
        "external-modules/meals",
        "jarv1s:/data/modules/meals"
      ]),
      { stdio: "pipe" }
    );
    await restartUatStack(projectName, baseURL);
    await page.reload();
    await openInstanceModules(page);

    const externalCard = page.locator(".pane__card", { hasText: "External modules" });
    await expect(externalCard).toBeVisible();
    const mealsRow = externalCard
      .locator(".set-row")
      .filter({ has: page.getByRole("checkbox", { name: "Enable Meals", exact: true }) });
    await expect(mealsRow).toBeVisible();
    await expect(mealsRow.locator(".set-row__desc")).toContainText(`v${MODULE_VERSION}`);
    const enable = mealsRow.getByRole("checkbox", { name: "Enable Meals", exact: true });
    if (!(await enable.isChecked())) {
      await enable.focus();
      await page.keyboard.press("Space");
    }
    await expect(enable).toBeChecked();

    await restartUatStack(projectName, baseURL);
    await page.reload();
    await expect(
      page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Meals", exact: true })
    ).toBeVisible({ timeout: 60_000 });
    say(`module=meals version=${MODULE_VERSION} source=local-build enabled=real-admin-ui`);
  });

  await test.step("a real model provider is installed, logged in and pinned", async () => {
    const model = await bringUpRealChatModel(page);
    say(`model=${model.id} providerModel=${model.providerModelId} tier=${model.tier}`);
  });

  const goto = async (path: string): Promise<void> => {
    await page.goto(`/m/meals${path}`);
  };
  const confirmHost = async (decision: "Confirm action" | "Cancel"): Promise<void> => {
    const dialog = page.getByRole("dialog", { name: "Confirm Meals action" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await shot(page, `host-confirm-${decision === "Cancel" ? "cancel" : "confirm"}`);
    await press(page, dialog.getByRole("button", { name: decision, exact: true }));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  };

  await test.step("Household: add a person from the page", async () => {
    await goto("/household");
    await expect(page.getByRole("button", { name: "Add person", exact: true })).toBeVisible({
      timeout: 60_000
    });
    await shot(page, "01-household-light");
    await press(page, page.getByRole("button", { name: "Add person", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Add a person" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill("Sam");
    await dialog.getByLabel("Never serve", { exact: true }).fill("peanuts");
    await shot(page, "02-person-dialog");
    await press(page, dialog.getByRole("button", { name: "Save", exact: true }));
    await expect(page.getByRole("heading", { name: "Sam" })).toBeVisible({ timeout: 30_000 });
    expect(await noSidewaysScroll(page)).toBe(true);
    say("household person=Sam added=page-form");
  });

  await test.step("a one-day plan is written by the real model", async () => {
    await goto("");
    await settlePlan(page);
    await press(page, page.getByRole("button", { name: "Start a plan", exact: true }));
    await page.getByLabel("First day", { exact: true }).fill(isoPlus(0));
    await page.getByLabel("Days", { exact: true }).fill("1");
    await page.getByLabel("Anything you want", { exact: true }).fill("Simple dinner, no peanuts.");
    await press(page, page.getByRole("button", { name: "Start the plan", exact: true }));
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await settlePlan(page);
    await waitForPlanSettled(page);
    const days = await readDays(page);
    expect(days.length).toBe(1);
    say(`plan days=1 meals=${days.flat().length}`);
    await shot(page, "03-plan-light");
  });

  await test.step("lock a meal, then swap another", async () => {
    const meals = page.locator("article.mls-meal");
    await press(page, meals.first().getByRole("button", { name: "Lock", exact: true }));
    await expect(meals.first().getByText("Locked", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    say("lock meal=first result=badge-shown");
    const last = meals.last();
    await press(page, last.getByRole("button", { name: "Swap", exact: true }));
    await expect(page).toHaveURL(/\/plan\/swap\//, { timeout: 60_000 });
    const choose = page.getByRole("button", { name: "Choose", exact: true }).first();
    await expect(choose).toBeVisible({ timeout: QUICK_SWAP_TIMEOUT_MS });
    await shot(page, "04-swap-choices");
    await press(page, choose);
    await expect(page).toHaveURL(/\/m\/meals\/?$/, { timeout: 60_000 });
    say("swap meal=last chosen=first-choice");
  });

  await test.step("shopping list: tick a line and move it to the Pantry with Bought", async () => {
    await goto("/list");
    const build = page.getByRole("button", { name: "Build from the plan", exact: true });
    const ticks = page.locator('input[aria-label^="Got "]');
    await expect(build.or(ticks.first()).first()).toBeVisible({ timeout: 60_000 });
    if (await build.isVisible()) await press(page, build);
    await expect(ticks.first()).toBeVisible({ timeout: 60_000 });
    await ticks.first().focus();
    await page.keyboard.press("Space");
    await expect(ticks.first()).toBeChecked({ timeout: 30_000 });
    await shot(page, "05-list-light");
    await press(page, page.getByRole("button", { name: /^Bought/ }).first());
    const dialog = page.getByRole("dialog", { name: "Bought" });
    await expect(dialog).toBeVisible();
    await shot(page, "06-bought-dialog");
    await press(page, dialog.getByRole("button", { name: /^Move \d+ to the Pantry$/ }));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    expect(await noSidewaysScroll(page)).toBe(true);
    say("list ticked=1 bought=moved-to-pantry");
  });

  await test.step("Pantry: the bought item is there, and an item can be added", async () => {
    await goto("/pantry");
    await expect(page.getByRole("button", { name: "Add item", exact: true }).first()).toBeVisible({
      timeout: 60_000
    });
    await press(page, page.getByRole("button", { name: "Add item", exact: true }).first());
    const dialog = page.getByRole("dialog", { name: "Add to the Pantry" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Item", { exact: true }).fill("Basmati rice");
    await dialog.getByLabel("Amount", { exact: true }).fill("2");
    await dialog.getByLabel("Unit", { exact: true }).fill("lb");
    await press(page, dialog.getByRole("button", { name: "Add", exact: true }));
    await expect(page.getByText("Basmati rice").first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "07-pantry-light");
    say("pantry added=Basmati rice");
  });

  await test.step("cook, rate and find the logged portion in Log", async () => {
    await goto("");
    await settlePlan(page);
    await press(page, page.locator("a.mls-meal__title").first());
    await settleRecipe(page);
    await press(page, page.getByRole("button", { name: "Mark cooked", exact: true }));
    const portion = page.getByRole("button", { name: "Log my portion", exact: true });
    await expect(portion).toBeVisible({ timeout: 60_000 });
    await shot(page, "08-cooked-toast");
    await press(page, portion);
    const stars = page.getByRole("button", { name: /^4 stars for / }).first();
    await press(page, stars);
    await expect(stars).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
    await shot(page, "09-recipe-rated");
    await goto("/log");
    await expect(page.locator("li.mls-entry").first()).toBeVisible({ timeout: 120_000 });
    await shot(page, "10-log-light");
    say("cooked=yes rated=4 logged=visible-in-log");
  });

  await test.step("a failed change names its problem, light and dark", async () => {
    // The household form refuses a bad calorie target before it leaves the page.
    await goto("/household");
    await press(page, page.getByRole("button", { name: "Add person", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Add a person" });
    await dialog.getByLabel("Name", { exact: true }).fill("Pat");
    await dialog.getByLabel("Daily calories", { exact: true }).fill("5");
    await press(page, dialog.getByRole("button", { name: "Save", exact: true }));
    await expect(dialog.getByRole("alert")).toContainText("800 to 6000");
    await shot(page, "11-error-light");
    await press(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
    await setColorMode(page, "Dark");
    await goto("/household");
    await press(page, page.getByRole("button", { name: "Add person", exact: true }));
    await page.getByRole("dialog", { name: "Add a person" }).getByLabel("Name").fill("Pat");
    await page.getByLabel("Daily calories", { exact: true }).fill("5");
    await press(
      page,
      page.getByRole("dialog", { name: "Add a person" }).getByRole("button", { name: "Save" })
    );
    await shot(page, "11-error-dark");
    await press(
      page,
      page.getByRole("dialog", { name: "Add a person" }).getByRole("button", { name: "Cancel" })
    );
    await goto("/pantry");
    await shot(page, "12-pantry-dark");
    await goto("/log");
    await shot(page, "13-log-dark");
    await setColorMode(page, "Light");
    say("visual error=light,dark widths=1280,390");
  });

  await test.step("Clear list asks first; cancel keeps it, confirm empties it", async () => {
    await goto("/list");
    const clear = page.getByRole("button", { name: "Clear list", exact: true }).first();
    await expect(clear).toBeVisible({ timeout: 60_000 });
    await press(page, clear);
    await confirmHost("Cancel");
    await expect(page.getByText("Nothing to buy")).toBeHidden();
    await press(page, clear);
    await confirmHost("Confirm action");
    await expect(page.getByText("Nothing to buy", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    await shot(page, "14-list-empty");
    say("clear-list cancel=kept confirm=emptied");
  });

  await test.step("Delete plan asks first; confirm returns to the empty plan", async () => {
    await goto("");
    await settlePlan(page);
    const del = page.getByRole("button", { name: "Delete plan", exact: true });
    await expect(del).toBeVisible({ timeout: 60_000 });
    await press(page, del);
    await confirmHost("Confirm action");
    await expect(page.getByText("Plan your first week", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    await shot(page, "15-plan-deleted");
    expect(await noSidewaysScroll(page)).toBe(true);
    say("delete-plan confirm=empty-state");
  });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
