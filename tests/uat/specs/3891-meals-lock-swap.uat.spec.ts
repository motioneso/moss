// tests/uat/specs/3891-meals-lock-swap.uat.spec.ts
//
// #3891 Meals slice 7 live-path proof: lock two meals, regenerate the week and confirm both
// survive, request swap choices from a real model and choose one, tick shopping lines, then
// regenerate one day and confirm the ticks survive while amounts update.
//
// Everything runs through the real Meals page on a disposable prod-shaped stack, signed in as
// the harness's seeded owner through the real sign-in form. Meals is an unlisted external
// module, so this spec builds it from this working tree, drops it on the instance's module
// disk, restarts so the boot scan sees it, and enables it through Settings -> Admin / Setup ->
// Instance modules, the same path an operator uses. Generation calls a real model: the
// provisioner copies the operator's own Codex login into the stack (tests/uat/real-chat-env.ts)
// and this spec pins the cheapest chat+json model. Nothing here intercepts, stubs or rewrites a
// response.
//
// Screenshots are written only when MEALS_S7_SHOT_DIR is set, at 1280 and 390 wide.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

test.use({ trace: "off", screenshot: "off", video: "off" });

const SHOT_DIR = process.env.MEALS_S7_SHOT_DIR ?? "";
/** The version this working tree built, so a stale copy on the instance cannot pass. */
const MODULE_VERSION = (
  JSON.parse(readFileSync("external-modules/meals/jarvis.module.json", "utf8")) as {
    version: string;
  }
).version;
const PLAN_DAYS = 3;
const MODULE_BUILD_TIMEOUT_MS = 180_000;
const PLAN_WRITE_TIMEOUT_MS = 20 * 60_000;
const SWAP_CHOICES_TIMEOUT_MS = 10 * 60_000;

interface MealRow {
  readonly title: string;
  readonly id: string;
  readonly locked: boolean;
}

interface DayRow {
  readonly label: string;
  readonly meals: readonly MealRow[];
}

interface LineRow {
  readonly name: string;
  readonly amount: string;
  readonly sources: string;
  readonly checked: boolean;
}

/** Key evidence line. Kept in one shape so the PR comment can quote them straight. */
function say(message: string): void {
  console.log(`MEALS_S7 ${message}`);
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

async function readDays(page: Page): Promise<DayRow[]> {
  return page.locator("section.mls-day").evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: node.getAttribute("aria-label") ?? "",
      meals: [...node.querySelectorAll("article.mls-meal")].map((meal) => {
        const href = meal.querySelector("a.mls-meal__title")?.getAttribute("href") ?? "";
        return {
          title: meal.querySelector(".mls-meal__title")?.textContent?.trim() ?? "",
          // The recipe link carries the planned meal's own id: a replaced meal gets a new one.
          id: href.split("/").pop() ?? "",
          locked: [...meal.querySelectorAll(".jds-badge")].some(
            (badge) => (badge.textContent ?? "").trim() === "Locked"
          )
        };
      })
    }))
  );
}

async function readLines(page: Page): Promise<LineRow[]> {
  return page.locator("li.mls-line").evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.querySelector(".mls-line__name")?.textContent?.trim() ?? "",
      amount: node.querySelector(".mls-line__amount .mls-num")?.textContent?.trim() ?? "",
      sources: [...node.querySelectorAll(".jds-caption")]
        .map((caption) => (caption.textContent ?? "").trim())
        .join(" | "),
      checked: node.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false
    }))
  );
}

/** Waits until the plan has visibly started writing again after a regenerate request. */
async function waitForWritingToStart(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const writingMeals = await page.locator(".mls-writing").count();
        const writingBanner = await page.getByText("Writing your plan", { exact: true }).count();
        const progress = await page.getByRole("progressbar", { name: "Days written" }).count();
        return writingMeals + writingBanner + progress;
      },
      { timeout: 2 * 60_000, intervals: [500, 1_000, 2_000] }
    )
    .toBeGreaterThan(0);
}

/** Waits until every day is written and the plan bar offers Regenerate again. */
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

async function lockFirstMealOfDay(page: Page, dayIndex: number): Promise<string> {
  const meal = page.locator("section.mls-day").nth(dayIndex).locator("article.mls-meal").first();
  const title = (await meal.locator(".mls-meal__title").innerText()).trim();
  await meal.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(meal.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
  await expect(meal.locator(".jds-badge", { hasText: "Locked" })).toBeVisible();
  return title;
}

interface RecipeRead {
  readonly recipeId: string | null;
  readonly meal: { readonly title: string };
  readonly swapChoices: readonly {
    readonly choiceId: string;
    readonly status: string;
    readonly recipeId: string | null;
  }[];
}

/**
 * Reads one meal through the same read route the Meals page itself calls, so a regenerated or
 * swapped meal can be told apart from a model that happened to repeat a recipe name.
 */
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

test("lock, regenerate and swap choices run through the real Meals page on generated data", async ({
  page
}) => {
  test.setTimeout(40 * 60_000);
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
    // Restart runs the boot-time module scan, so the dropped-in copy appears as an external module.
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
    await expect(mealsRow.locator("label.jds-switch")).toBeVisible();
    if (!(await enable.isChecked())) await mealsRow.locator("label.jds-switch").click();
    await expect(enable).toBeChecked();

    // The API must be running the new code before the enable is trusted; a restart re-runs the
    // boot scan and module reconciliation, then the module serves its routes.
    await restartUatStack(projectName, baseURL);
    await page.reload();
    await expect(
      page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Meals", exact: true })
    ).toBeVisible({ timeout: 60_000 });
    say(
      `module=meals version=${MODULE_VERSION} source=local-build enabled=real-admin-ui restart=verified`
    );
  });

  await test.step("a real model provider is installed, logged in and pinned", async () => {
    const model = await bringUpRealChatModel(page);
    say(
      `model=${model.id} providerModel=${model.providerModelId} tier=${model.tier} pinned=admin-pin`
    );
  });

  await test.step("a 3-day plan is written by the real model", async () => {
    await openMeals(page);
    await expect(page.getByText("Plan your first week", { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await page.getByRole("button", { name: "Start a plan", exact: true }).click();
    await expect(page.getByLabel("Days", { exact: true })).toBeVisible();
    await page.getByLabel("Days", { exact: true }).fill(String(PLAN_DAYS));
    await page
      .getByLabel("Anything you want", { exact: true })
      .fill("Simple weeknight dinners and easy breakfasts.");
    await page.getByRole("button", { name: "Start the plan", exact: true }).click();
    // The page returns to the Plan tab and streams the days as Moss writes them.
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);

    const days = await readDays(page);
    expect(days.length).toBe(PLAN_DAYS);
    for (const day of days) {
      expect(day.meals.length, `day ${day.label} should have three meals`).toBe(3);
      for (const meal of day.meals) expect(meal.title).not.toBe("");
    }
    const titles = days.flatMap((day) => day.meals.map((meal) => meal.title));
    say(`plan days=${days.length} meals=${titles.length} titles=${titles.join(" / ")}`);
    await shot(page, "01-plan-written");
  });

  await test.step("two meals are locked and the week regenerates around them", async () => {
    const firstLocked = await lockFirstMealOfDay(page, 0);
    const secondLocked = await lockFirstMealOfDay(page, 1);
    say(`locked meals="${firstLocked}" "${secondLocked}"`);

    const before = await readDays(page);
    const beforeMeals = before.flatMap((day) => day.meals);
    const lockedMeals = beforeMeals.filter((meal) => meal.locked);
    expect(lockedMeals.length, "two meals should be locked").toBe(2);
    // The plan view keeps a meal's identity when its recipe is rewritten, so record the recipe
    // itself through the module's own read route before regenerating.
    const recipesBefore = new Map<string, string | null>();
    for (const meal of beforeMeals) {
      recipesBefore.set(meal.id, (await readRecipe(page, meal.id)).recipeId);
    }

    await page
      .locator(".mls-planbar")
      .getByRole("button", { name: "Regenerate", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Regenerate the plan" });
    await expect(dialog).toBeVisible();
    const confirmText = (await dialog.innerText()).replace(/\s+/g, " ").trim();
    expect(confirmText).toContain("2 locked meals stay");
    expect(confirmText).toMatch(/\d+ meals will be replaced/);
    say(`regenerate dialog="${confirmText}"`);
    await dialog.getByRole("button", { name: "Regenerate", exact: true }).click();
    await waitForWritingToStart(page);
    await waitForPlanSettled(page);

    const after = await readDays(page);
    const afterMeals = after.flatMap((day) => day.meals);
    for (const locked of lockedMeals) {
      const kept = afterMeals.find((meal) => meal.id === locked.id);
      expect(
        kept,
        `locked meal "${locked.title}" should survive a whole-plan regenerate`
      ).toBeDefined();
      expect(kept?.title).toBe(locked.title);
      expect(kept?.locked).toBe(true);
    }
    // Every unlocked meal must now be a different recipe; the locked ones keep theirs.
    const unlockedBefore = beforeMeals.filter((meal) => !meal.locked);
    const unlockedAfter = afterMeals.filter((meal) => !meal.locked);
    const keptRecipes: string[] = [];
    for (const meal of unlockedAfter) {
      const recipeId = (await readRecipe(page, meal.id)).recipeId;
      if (recipeId !== null && recipesBefore.get(meal.id) === recipeId)
        keptRecipes.push(meal.title);
    }
    expect(keptRecipes, "every unlocked meal should have a new recipe").toEqual([]);
    for (const locked of lockedMeals) {
      const lockedRecipe = (await readRecipe(page, locked.id)).recipeId;
      expect(lockedRecipe, `locked meal "${locked.title}" keeps its own recipe`).toBe(
        recipesBefore.get(locked.id)
      );
    }
    expect(afterMeals.length, "the plan keeps all its meals").toBe(beforeMeals.length);
    say(
      `regenerate week kept=${lockedMeals.length} replaced=${unlockedBefore.length} ` +
        `newRecipes=${unlockedAfter.length} allDifferent=yes`
    );
    await shot(page, "02-plan-regenerated");
  });

  await test.step("swap choices come from the real model, pass Safety and one is chosen", async () => {
    const lastDay = (await readDays(page))[PLAN_DAYS - 1]!;
    const swapTarget = lastDay.meals[0]!;
    const mealId = swapTarget.id;
    const recipeBefore = await readRecipe(page, mealId);
    const oldTitle = swapTarget.title;
    const swapMeal = page
      .locator("section.mls-day")
      .nth(PLAN_DAYS - 1)
      .locator("article.mls-meal")
      .first();
    await swapMeal.getByRole("button", { name: "Swap", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/plan\/swap\//);
    await expect(page.getByRole("heading", { name: `Swap ${oldTitle}`, exact: true })).toBeVisible({
      timeout: 60_000
    });

    const options = page.getByRole("list", { name: "Replacement options" });
    await expect(options).toBeVisible({ timeout: SWAP_CHOICES_TIMEOUT_MS });
    await expect
      .poll(async () => options.getByRole("button", { name: "Choose", exact: true }).count(), {
        timeout: SWAP_CHOICES_TIMEOUT_MS,
        intervals: [1_000, 3_000]
      })
      .toBe(3);
    // The read route says the same thing: three choices finished writing and passed Safety
    // (a choice reaches "ready" only after the Safety check for everyone who eats the meal).
    const readyChoices = (await readRecipe(page, mealId)).swapChoices.filter(
      (choice) => choice.status === "ready"
    );
    expect(readyChoices.length, "three Safety-checked choices").toBe(3);
    const choiceTitles = (await options.locator(".mls-meal__title").allInnerTexts()).map((title) =>
      title.trim()
    );
    expect(new Set(choiceTitles).size).toBe(3);
    for (const title of choiceTitles) expect(title).not.toBe(oldTitle);
    say(
      `swap meal="${oldTitle}" choices=${choiceTitles.length} titles=${choiceTitles.join(" / ")}`
    );
    await shot(page, "03-swap-choices");

    const chosen = choiceTitles[0]!;
    await options.getByRole("button", { name: "Choose", exact: true }).first().click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);
    const recipeAfter = await readRecipe(page, mealId);
    expect(recipeAfter.recipeId, "the chosen recipe replaced the old one").not.toBe(
      recipeBefore.recipeId
    );
    expect(recipeAfter.meal.title).toBe(chosen);
    expect(recipeAfter.swapChoices, "the used choices are cleared").toEqual([]);
    const planTitles = (await readDays(page)).flatMap((day) => day.meals.map((meal) => meal.title));
    expect(planTitles).toContain(chosen);
    say(`chose="${chosen}" replaced="${oldTitle}" recipeChanged=yes choicesCleared=yes`);
  });

  await test.step("list lines are ticked, one day regenerates and the ticks survive", async () => {
    // Which meals feed the first day is read while the Plan tab is showing: the list tab has no
    // day sections at all.
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.locator("section.mls-day").first()).toBeVisible({ timeout: 60_000 });
    const firstDayTitles = (await readDays(page))[0]!.meals.map((meal) => meal.title);
    await page.getByRole("button", { name: "Shopping list", exact: true }).click();
    const firstLine = page.locator("li.mls-line").first();
    const build = page.getByRole("button", { name: "Build from the plan", exact: true });
    // Wait for the screen to settle into one of its two real states first: an `isVisible()` read
    // taken while the list is still loading is false and would skip the build entirely.
    await expect(build.or(firstLine).first()).toBeVisible({ timeout: 120_000 });
    // The list is empty until the owner builds it once from the written plan (the button the
    // screen offers in its empty state). Later rebuilds after a regenerate are automatic.
    if (await build.isVisible()) {
      await build.click();
      say("list built from plan (empty state button)");
    }
    await expect(firstLine).toBeVisible({ timeout: 120_000 });
    const beforeLines = await readLines(page);
    expect(beforeLines.length).toBeGreaterThan(3);

    // Regenerate the first day later, so tick lines that no first-day meal feeds: those are the
    // lines a rebuild can legitimately keep. Their ticks must survive it.
    const seenNames = new Set<string>();
    const candidates = beforeLines.filter((line) => {
      if (seenNames.has(line.name)) return false;
      if (!line.sources.includes("For ")) return false;
      if (firstDayTitles.some((title) => line.sources.includes(title))) return false;
      seenNames.add(line.name);
      return true;
    });
    expect(
      candidates.length,
      "need list lines not fed by the day being regenerated"
    ).toBeGreaterThan(1);
    const ticked = candidates.slice(0, 2).map((line) => line.name);
    for (const name of ticked) {
      await page.getByRole("checkbox", { name: `Got ${name}`, exact: true }).click();
      await expect(page.getByRole("checkbox", { name: `Got ${name}`, exact: true })).toBeChecked();
    }
    say(`ticked lines="${ticked.join('" "')}"`);
    await shot(page, "04-list-ticked");

    // Persistence through a real reload proves the tick reached the module's own tables.
    await page.reload();
    await page.getByRole("button", { name: "Shopping list", exact: true }).click();
    for (const name of ticked) {
      await expect(page.getByRole("checkbox", { name: `Got ${name}`, exact: true })).toBeChecked({
        timeout: 30_000
      });
    }
    const tickedBefore = await readLines(page);
    expect(tickedBefore.filter((line) => line.checked).length).toBeGreaterThanOrEqual(2);

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await waitForPlanSettled(page);
    const dayBefore = (await readDays(page))[0]!.meals;
    const lockedDay = dayBefore.filter((meal) => meal.locked);
    const replaceableDay = dayBefore.filter((meal) => !meal.locked);
    expect(replaceableDay.length, "the first day keeps one locked meal").toBeGreaterThan(0);
    const dayRecipesBefore = new Map<string, string | null>();
    for (const meal of replaceableDay) {
      dayRecipesBefore.set(meal.id, (await readRecipe(page, meal.id)).recipeId);
    }
    await page
      .locator("section.mls-day")
      .first()
      .getByRole("button", { name: "Regenerate day", exact: true })
      .click();
    await waitForWritingToStart(page);
    await waitForPlanSettled(page);
    const dayAfter = (await readDays(page))[0]!.meals;
    for (const meal of lockedDay) {
      expect(
        dayAfter.some((candidate) => candidate.id === meal.id && candidate.locked),
        "the locked meal on that day stays"
      ).toBe(true);
    }
    const keptDayRecipes: string[] = [];
    for (const meal of replaceableDay) {
      const recipeId = (await readRecipe(page, meal.id)).recipeId;
      if (recipeId !== null && dayRecipesBefore.get(meal.id) === recipeId)
        keptDayRecipes.push(meal.title);
    }
    expect(keptDayRecipes, "the day's unlocked meals are replaced").toEqual([]);
    const dayChanged = replaceableDay.length;

    await page.getByRole("button", { name: "Shopping list", exact: true }).click();
    await expect(page.locator("li.mls-line").first()).toBeVisible({ timeout: 60_000 });
    const afterLines = await readLines(page);

    const survivors = ticked.filter((name) =>
      afterLines.some((line) => line.name === name && line.checked)
    );
    expect(survivors, "ticks must survive a one-day regenerate").toEqual(ticked);
    for (const name of ticked) {
      const line = afterLines.find((candidate) => candidate.name === name);
      expect(line?.checked, `"${name}" should still be ticked`).toBe(true);
    }
    const beforeAmounts = new Map(beforeLines.map((line) => [line.name, line.amount]));
    const beforeNames = new Set(beforeLines.map((line) => line.name));
    const afterNames = new Set(afterLines.map((line) => line.name));
    const changed = afterLines.filter(
      (line) => beforeAmounts.has(line.name) && beforeAmounts.get(line.name) !== line.amount
    );
    const added = afterLines.filter((line) => !beforeNames.has(line.name)).map((line) => line.name);
    const removed = beforeLines
      .filter((line) => !afterNames.has(line.name))
      .map((line) => line.name);
    say(
      `list lines before=${beforeLines.length} after=${afterLines.length} ` +
        `dayChangedMeals=${dayChanged} ticksKept=${survivors.length}/${ticked.length} ` +
        `amountsChanged=${changed.map((line) => `${line.name}:${beforeAmounts.get(line.name)}->${line.amount}`).join(",") || "none"} ` +
        `added=${added.join(",") || "none"} removed=${removed.join(",") || "none"}`
    );
    expect(
      changed.length + added.length + removed.length,
      "the rebuilt list should show the regenerated day's changes"
    ).toBeGreaterThan(0);
    await shot(page, "05-list-after-day-regenerate");
  });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
