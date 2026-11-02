// tests/uat/specs/3893-meals-replan.uat.spec.ts
//
// #3893 Meals slice 9 live-path proof: on a plan that started yesterday, re-plan the rest of
// the week from the real Meals page and confirm the past day keeps its recipes while today
// and tomorrow are rewritten, then quick swap tonight's dinner to a 15-minute meal and read
// what is still to buy on its recipe.
//
// Everything runs through the real Meals page on a disposable prod-shaped stack, signed in as
// the harness's seeded owner through the real sign-in form. Meals is an unlisted external
// module, so this spec builds it from this working tree, drops it on the instance's module
// disk, restarts so the boot scan sees it, and enables it through Settings -> Admin / Setup ->
// Instance modules. Generation calls a real model through the provisioner's own provider
// setup. Nothing here intercepts, stubs or rewrites a response.
//
// Screenshots are written only when MEALS_S9_SHOT_DIR is set, at 1280 and 390 wide.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test.use({ trace: "off", screenshot: "off", video: "off" });

const SHOT_DIR = process.env.MEALS_S9_SHOT_DIR ?? "";
const MODULE_VERSION = (
  JSON.parse(readFileSync("external-modules/meals/jarvis.module.json", "utf8")) as {
    version: string;
  }
).version;
const MODULE_BUILD_TIMEOUT_MS = 180_000;
const PLAN_WRITE_TIMEOUT_MS = 20 * 60_000;
const QUICK_SWAP_TIMEOUT_MS = 10 * 60_000;

function say(message: string): void {
  console.log(`MEALS_S9 ${message}`);
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
  for (const [width, height] of [
    [1280, 900],
    [390, 844]
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

async function openInstanceModules(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "Instance modules", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
}

async function openMeals(page: Page): Promise<void> {
  await page
    .locator('nav[aria-label="Main"]')
    .getByRole("link", { name: "Meals", exact: true })
    .click();
  await expect(page).toHaveURL(/\/m\/meals/);
}

interface MealRow {
  readonly title: string;
  readonly id: string;
}

async function readDays(page: Page): Promise<readonly (readonly MealRow[])[]> {
  return page.locator("section.mls-day").evaluateAll((nodes) =>
    nodes.map((node) =>
      [...node.querySelectorAll("article.mls-meal")].map((meal) => {
        const href = meal.querySelector("a.mls-meal__title")?.getAttribute("href") ?? "";
        return {
          title: meal.querySelector(".mls-meal__title")?.textContent?.trim() ?? "",
          id: href.split("/").pop() ?? ""
        };
      })
    )
  );
}

interface RecipeRead {
  readonly recipeId: string | null;
  readonly meal: {
    readonly title: string | null;
    readonly status: string;
    readonly cookMinutes: number | null;
    readonly quickMaxMinutes: number | null;
  };
  readonly ingredients: readonly { readonly name: string; readonly missing: boolean }[];
}

async function readRecipe(page: Page, mealId: string): Promise<RecipeRead> {
  const response = await page.request.post(
    `/api/ai/assistant-tools/${encodeURIComponent("meals.meal.get")}/invoke`,
    { data: { input: { mealId } } }
  );
  expect(response.ok(), `meals.meal.get -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    invocation?: { status?: string; result?: RecipeRead };
  };
  expect(body.invocation?.status, "meals.meal.get should succeed").toBe("succeeded");
  return body.invocation!.result!;
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

test("re-plan the rest of the week and quick swap tonight through the real Meals page", async ({
  page
}) => {
  test.setTimeout(45 * 60_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!baseURL || !projectName) throw new Error("Disposable UAT stack required");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await test.step("the seeded owner signs in through the real sign-in form", async () => {
    await signInUatAdmin(page);
    await page.reload();
    await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
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
    if (!(await enable.isChecked())) await mealsRow.locator("label.jds-switch").click();
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

  let before: readonly (readonly MealRow[])[];
  await test.step("a 3-day plan starting yesterday is written by the real model", async () => {
    await openMeals(page);
    await expect(page.getByText("Plan your first week", { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await shot(page, "01-empty");
    await page.getByRole("button", { name: "Start a plan", exact: true }).click();
    await page.getByLabel("First day", { exact: true }).fill(isoPlus(-1));
    await page.getByLabel("Days", { exact: true }).fill("3");
    await page
      .getByLabel("Anything you want", { exact: true })
      .fill("Simple weeknight dinners and easy breakfasts.");
    await page.getByRole("button", { name: "Start the plan", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await shot(page, "02-writing");
    await waitForPlanSettled(page);
    before = await readDays(page);
    expect(before.length).toBe(3);
    for (const day of before) expect(day.length).toBe(3);
    say(`plan days=3 meals=${before.flat().length} firstDay=${isoPlus(-1)}`);
    await shot(page, "03-plan-written");
  });

  await test.step("re-plan keeps the past day and rewrites today and tomorrow", async () => {
    const recipesBefore = new Map<string, string | null>();
    for (const meal of before!.flat()) {
      recipesBefore.set(meal.id, (await readRecipe(page, meal.id)).recipeId);
    }
    await page.getByRole("button", { name: "Re-plan the rest of the week", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Re-plan the rest of the week" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Re-plan", exact: true }).click();
    await waitForPlanSettled(page);

    const after = await readDays(page);
    expect(after.length).toBe(3);
    for (const meal of after[0]!) {
      expect(await readRecipe(page, meal.id).then((read) => read.recipeId)).toBe(
        recipesBefore.get(meal.id)
      );
    }
    let rewritten = 0;
    for (const meal of [...after[1]!, ...after[2]!]) {
      const recipeId = (await readRecipe(page, meal.id)).recipeId;
      expect(recipeId, `meal "${meal.title}" should have been rewritten`).not.toBe(
        recipesBefore.get(meal.id)
      );
      rewritten += 1;
    }
    say(`replan pastDayKept=${after[0]!.length} rewritten=${rewritten}`);
    await shot(page, "04-replanned");
  });

  await test.step("quick swap makes tonight's dinner a 15-minute meal", async () => {
    const today = (await readDays(page))[1]!;
    const dinner = today[today.length - 1]!;
    const beforeRecipe = await readRecipe(page, dinner.id);
    const dinnerArticle = page.locator("section.mls-day").nth(1).locator("article.mls-meal").last();
    await dinnerArticle.getByRole("button", { name: "Quick swap", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Quick swap" });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Ready in at most, minutes", { exact: true })).toHaveValue("15");
    await dialog.getByRole("button", { name: "Swap it", exact: true }).click();

    await expect
      .poll(
        async () => {
          const read = await readRecipe(page, dinner.id);
          return read.meal.status === "ready" &&
            read.meal.quickMaxMinutes === 15 &&
            read.recipeId !== beforeRecipe.recipeId
            ? "swapped"
            : read.meal.status;
        },
        { timeout: QUICK_SWAP_TIMEOUT_MS, intervals: [2_000, 5_000] }
      )
      .toBe("swapped");
    const swapped = await readRecipe(page, dinner.id);
    expect(swapped.meal.cookMinutes).not.toBeNull();
    expect(swapped.meal.cookMinutes!).toBeLessThanOrEqual(15);
    const stillToBuy = swapped.ingredients.filter((line) => line.missing).map((line) => line.name);
    say(
      `quickswap from="${beforeRecipe.meal.title}" to="${swapped.meal.title}" ` +
        `minutes=${swapped.meal.cookMinutes} stillToBuy=${stillToBuy.join(",") || "none"}`
    );

    await page
      .locator("section.mls-day")
      .nth(1)
      .locator("article.mls-meal")
      .last()
      .locator("a.mls-meal__title")
      .click();
    await expect(
      page.getByText(/Still to buy:|Nothing still to buy/, { exact: false })
    ).toBeVisible({
      timeout: 60_000
    });
    await shot(page, "05-quick-recipe");
  });

  await test.step("the plan reads clean in dark mode at both widths", async () => {
    await page.goto("/m/meals");
    await expect(page.locator("section.mls-day").first()).toBeVisible({ timeout: 60_000 });
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .getByRole("group", { name: "Color mode", exact: true })
      .getByRole("button", { name: "Dark", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
    await page.goto("/m/meals");
    await expect(page.locator("section.mls-day").first()).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await shot(page, "06-plan-dark");
    say("visual dark=yes widths=1280,390 sidewaysScroll=no");
  });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
