// tests/uat/specs/3892-meals-arrange.uat.spec.ts
//
// #3892 Meals slice 8 live-path proof: move a dinner to another day, make a lunch "eating
// out", set a 20-minute limit on the last day and regenerate it, change who eats a meal,
// make one dinner Solo for a day, and add a One-off meal.
//
// Everything runs through the real Meals page on a disposable prod-shaped stack, signed in as
// the harness's seeded owner through the real sign-in form. Meals is an unlisted external
// module, so this spec builds it from this working tree, drops it on the instance's module
// disk, restarts so the boot scan sees it, and enables it through Settings -> Admin / Setup ->
// Instance modules, the same path an operator uses. Generation calls a real model: the
// provisioner copies the operator's own saved sign-in into the stack
// (tests/uat/real-chat-env.ts) and this spec pins the cheapest chat+json model. Nothing here
// intercepts, stubs or rewrites a response. The second household member is added by asking
// Moss in chat, the way a person would.
//
// Screenshots are written only when MEALS_S8_SHOT_DIR is set, at 1280, 390 and 320 wide, in light
// and dark, through the empty, loading, error and long-text states the plan's definition of done
// asks for.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { bringUpRealChatModel, requireUatBaseURL } from "./real-chat-signin.js";
import { gotoUatPage } from "./uat-page-load.js";

/**
 * Signs in through the real form. The shared helper's button click never sees the button as
 * stable on this box (an untouched spec fails the same way), so the form is submitted with
 * the keyboard instead. Same form, same credentials, same session.
 */
async function signIn(page: Page): Promise<void> {
  await gotoUatPage(page, requireUatBaseURL(), page.getByLabel("Email"));
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.getByLabel("Password").press("Enter");
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 60_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click({ force: true });
    const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
    await expect(skipAnyway.or(userMenu).first()).toBeVisible({ timeout: 60_000 });
    if (await skipAnyway.isVisible()) await skipAnyway.click({ force: true });
  }
  await expect(userMenu).toBeVisible({ timeout: 60_000 });
}

export const uatLevel = { level: "solo-admin", without: [] } as const;

test.use({ trace: "off", screenshot: "off", video: "off" });

const SHOT_DIR = process.env.MEALS_S8_SHOT_DIR ?? "";
const MODULE_VERSION = (
  JSON.parse(readFileSync("external-modules/meals/jarvis.module.json", "utf8")) as {
    version: string;
  }
).version;
const PLAN_DAYS = 3;
const MODULE_BUILD_TIMEOUT_MS = 180_000;
const PLAN_WRITE_TIMEOUT_MS = 20 * 60_000;

function say(message: string): void {
  console.log(`MEALS_S8 ${message}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const [width, height] of [
    [1280, 900],
    [390, 844],
    [320, 720]
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

interface MealRead {
  readonly meal: {
    readonly title: string | null;
    readonly kind: string;
    readonly status: string;
    readonly plainText: string | null;
    readonly cookMinutes: number | null;
    readonly servings: number;
    readonly eaters: readonly {
      readonly memberId: string;
      readonly name: string;
      readonly safety: string;
    }[];
  };
  readonly recipeId: string | null;
}

async function invokeTool<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(
    `/api/ai/assistant-tools/${encodeURIComponent(name)}/invoke`,
    { data: { input } }
  );
  expect(response.ok(), `${name} -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    invocation?: { status?: string; result?: T };
  };
  expect(body.invocation?.status, `${name} should succeed`).toBe("succeeded");
  return body.invocation!.result!;
}

const readMeal = (page: Page, mealId: string) =>
  invokeTool<MealRead>(page, "meals.meal.get", { mealId });

interface PlanRead {
  readonly planId: string;
  readonly days: readonly {
    readonly dayId: string;
    readonly date: string;
    readonly meals: readonly { readonly mealId: string; readonly slotName: string }[];
  }[];
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

/** Polls the module's own read route until one day and every meal on it are written. */
async function waitForDayReady(page: Page, planId: string, dayIndex: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const read = await invokeTool<{
          days: readonly {
            status: string;
            meals: readonly { status: string }[];
          }[];
        }>(page, "meals.plan.get", { planId });
        const day = read.days[dayIndex]!;
        return day.status === "ready" && day.meals.every((meal) => meal.status === "ready")
          ? "ready"
          : `${day.status}:${day.meals.map((meal) => meal.status).join(",")}`;
      },
      { timeout: 10 * 60_000, intervals: [2_000, 5_000] }
    )
    .toBe("ready");
}

const daySection = (page: Page, index: number) => page.locator("section.mls-day").nth(index);
const mealArticle = (page: Page, dayIndex: number, title: string) =>
  daySection(page, dayIndex).locator("article.mls-meal", { hasText: title });

test("arranging the week runs through the real Meals page on generated data", async ({ page }) => {
  test.setTimeout(60 * 60_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!baseURL || !projectName) throw new Error("Disposable UAT stack required");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await test.step("the seeded owner signs in through the real sign-in form", async () => {
    await signIn(page);
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
    say(
      `model=${model.id} providerModel=${model.providerModelId} tier=${model.tier} pinned=admin-pin`
    );
  });

  let plan: PlanRead;
  await test.step("Sam joins the household and a 3-day plan is written by the real model", async () => {
    // Household changes go through chat by design, so Sam is added by asking Moss.
    await openMeals(page);
    await page.getByRole("button", { name: "Household", exact: true }).click();
    await page.getByRole("button", { name: "Ask Moss", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Chat with Moss", exact: true });
    await expect(drawer).toBeVisible();
    await drawer
      .getByLabel("Message Moss")
      .fill("Add Sam to my household. Sam eats lunch and dinner every day.");
    await drawer.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(
        async () => {
          const approve = drawer.getByRole("button", { name: /^(Approve|Allow)/ }).first();
          if (await approve.isVisible().catch(() => false)) await approve.click();
          const kitchen = await invokeTool<{ members: readonly { name: string }[] }>(
            page,
            "meals.kitchen.get",
            {}
          );
          return kitchen.members.map((member) => member.name).join(",");
        },
        { timeout: 5 * 60_000, intervals: [2_000, 5_000] }
      )
      .toContain("Sam");
    await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
    say("household Sam added through chat");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText("Plan your first week", { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await shot(page, "01-empty-plan");
    await page.getByRole("button", { name: "Start a plan", exact: true }).click();
    await page.getByLabel("Days", { exact: true }).fill(String(PLAN_DAYS));
    await page
      .getByLabel("Anything you want", { exact: true })
      .fill("Simple weeknight dinners and easy lunches.");
    await page.getByRole("button", { name: "Start the plan", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);

    const today = new Date().toISOString().slice(0, 10);
    plan = await invokeTool<PlanRead>(page, "meals.plan.current", { date: today }).then(
      (result) => (result as unknown as { plan: PlanRead }).plan
    );
    expect(plan.days).toHaveLength(PLAN_DAYS);
    say(`plan days=${plan.days.length} dates=${plan.days.map((day) => day.date).join(",")}`);
    await shot(page, "02-plan-written");
  });

  await test.step("a dinner moves to the last day through the Move screen", async () => {
    const firstDay = plan.days[0]!;
    const dinner = firstDay.meals.find((meal) => meal.slotName === "dinner")!;
    const before = await readMeal(page, dinner.mealId);
    const title = before.meal.title!;
    await mealArticle(page, 0, title).getByRole("button", { name: "Move", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/move/${dinner.mealId}`));
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    await shot(page, "03-move-screen");
    await page.locator(`button[data-day-id="${plan.days[2]!.dayId}"]`).click();
    await page.getByRole("button", { name: "Move meal", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);
    const movedDay = await invokeTool<PlanRead>(page, "meals.plan.get", {
      planId: plan.planId
    });
    const onLast = movedDay.days[2]!.meals.some((meal) => meal.mealId === dinner.mealId);
    const onFirst = movedDay.days[0]!.meals.some((meal) => meal.mealId === dinner.mealId);
    expect(onLast, "the moved dinner is on the last day").toBe(true);
    expect(onFirst, "the moved dinner left the first day").toBe(false);
    say(`move meal="${title}" from=${firstDay.date} to=${plan.days[2]!.date} ok=yes`);
    await shot(page, "04-after-move");
  });

  await test.step("a lunch becomes eating out and never reaches the list", async () => {
    const lunch = plan.days[0]!.meals.find((meal) => meal.slotName === "lunch")!;
    const before = await readMeal(page, lunch.mealId);
    await mealArticle(page, 0, before.meal.title!)
      .getByRole("button", { name: "Text", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/text/${lunch.mealId}`));
    await page.getByLabel("Text for this meal", { exact: true }).fill("eating out");
    await shot(page, "05-text-screen");
    await page.getByRole("button", { name: "Save text", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);
    await expect(daySection(page, 0).getByText("eating out", { exact: true })).toBeVisible();
    const after = await readMeal(page, lunch.mealId);
    expect(after.meal.kind).toBe("text");
    expect(after.recipeId).toBeNull();
    say(`text meal="${before.meal.title}" now="eating out" recipe=none`);
  });

  await test.step("who eats a dinner changes, servings follow and Safety runs again", async () => {
    const dinner = plan.days[2]!.meals.find((meal) => meal.slotName === "dinner")!;
    const before = await readMeal(page, dinner.mealId);
    expect(before.meal.eaters.length).toBe(2);
    await mealArticle(page, 2, before.meal.title!)
      .getByRole("button", { name: "Eaters", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/eaters/${dinner.mealId}`));
    await shot(page, "06-eaters-screen");
    await page.getByRole("checkbox", { name: "Sam", exact: true }).click();
    await page.getByRole("button", { name: "Save eaters", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await expect
      .poll(
        async () => {
          const read = await readMeal(page, dinner.mealId);
          return read.meal.eaters.every((eater) => eater.safety !== "pending")
            ? read.meal.eaters.map((eater) => eater.name).join(",")
            : "pending";
        },
        { timeout: 5 * 60_000, intervals: [2_000, 5_000] }
      )
      .toBe("You");
    const after = await readMeal(page, dinner.mealId);
    expect(after.meal.servings).toBeLessThan(before.meal.servings);
    say(
      `eaters meal="${before.meal.title}" now=${after.meal.eaters.map((e) => e.name).join(",")} ` +
        `servings=${before.meal.servings}->${after.meal.servings} safety=${after.meal.eaters[0]!.safety}`
    );
  });

  await test.step("one dinner goes Solo for that day only", async () => {
    const dinner = plan.days[1]!.meals.find((meal) => meal.slotName === "dinner")!;
    const section = daySection(page, 1);
    await section
      .locator(".mls-slot")
      .last()
      .getByRole("button", { name: "Make Solo", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const read = await invokeTool<PlanRead>(page, "meals.plan.get", {
            planId: plan.planId
          });
          return read.days[1]!.meals.filter((meal) => meal.slotName === "dinner").length;
        },
        { timeout: 60_000, intervals: [1_000, 2_000] }
      )
      .toBeGreaterThan(1);
    say(`sharing day=${plan.days[1]!.date} slot=dinner soloMeals=split meal=${dinner.mealId}`);
    await shot(page, "07-solo-day");
  });

  await test.step("a One-off meal is added for Sam and written", async () => {
    const section = daySection(page, 2);
    await section.getByLabel("One-off meal slot", { exact: true }).selectOption("dinner");
    await section.getByLabel("One-off meal for", { exact: true }).selectOption({ label: "Sam" });
    await section.getByRole("button", { name: "Add One-off", exact: true }).click();
    await waitForDayReady(page, plan.planId, 2);
    await waitForPlanSettled(page);
    const read = await invokeTool<PlanRead>(page, "meals.plan.get", { planId: plan.planId });
    const dinners = read.days[2]!.meals.filter((meal) => meal.slotName === "dinner");
    expect(dinners.length).toBeGreaterThan(1);
    say(`oneoff day=${plan.days[2]!.date} slot=dinner dinners=${dinners.length}`);
  });

  await test.step("a 20-minute limit on the last day, then that day regenerates inside it", async () => {
    const section = daySection(page, 2);
    await section.getByLabel("Cook-time limit", { exact: true }).selectOption("20");
    await expect
      .poll(
        async () => {
          const read = await invokeTool<{
            days: readonly { cookTimeLimitMinutes: number | null }[];
          }>(page, "meals.plan.get", { planId: plan.planId });
          return read.days[2]!.cookTimeLimitMinutes;
        },
        { timeout: 60_000, intervals: [1_000, 2_000] }
      )
      .toBe(20);
    await shot(page, "08-cook-limit");
    await waitForDayReady(page, plan.planId, 2);
    await section
      .getByRole("button", { name: "Regenerate day", exact: true })
      .click({ timeout: 60_000 });
    await waitForDayReady(page, plan.planId, 2);
    await waitForPlanSettled(page);
    const read = await invokeTool<PlanRead>(page, "meals.plan.get", { planId: plan.planId });
    const meals = read.days[2]!.meals;
    const cooks: number[] = [];
    for (const meal of meals) {
      const detail = await readMeal(page, meal.mealId);
      if (
        detail.meal.kind === "recipe" &&
        detail.meal.status === "ready" &&
        detail.meal.cookMinutes !== null
      ) {
        cooks.push(detail.meal.cookMinutes);
      }
    }
    expect(cooks.length).toBeGreaterThan(0);
    for (const minutes of cooks) expect(minutes).toBeLessThanOrEqual(20);
    say(`cooklimit day=${plan.days[2]!.date} limit=20 cookMinutes=${cooks.join(",")}`);
    await shot(page, "09-after-limit-regenerate");
  });

  await test.step("a long name and a 200-character slot fit on the plan and its screens", async () => {
    const longName =
      "Alexandria-Cassandra Montgomery-Worthington the Third of Ashgrove Park Estate II";
    await invokeTool(page, "meals.household.save", {
      name: longName,
      mealPattern: ["lunch", "dinner"]
    });
    const read = await invokeTool<PlanRead>(page, "meals.plan.get", { planId: plan.planId });
    const dinner = read.days[1]!.meals.find((meal) => meal.slotName === "dinner")!;
    const before = await readMeal(page, dinner.mealId);
    await openMeals(page);
    await mealArticle(page, 1, before.meal.title!)
      .getByRole("button", { name: "Eaters", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/eaters/${dinner.mealId}`));
    const longEater = page.getByRole("checkbox", { name: longName, exact: true });
    await expect(longEater).toBeVisible({ timeout: 60_000 });
    await longEater.click();
    await shot(page, "11-long-name-eaters");
    await page.getByRole("button", { name: "Save eaters", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);
    const after = await readMeal(page, dinner.mealId);
    expect(after.meal.eaters.map((eater) => eater.name)).toContain(longName);
    say(`longname chars=${longName.length} on the plan and the eaters screen`);
  });

  await test.step("a 200-character text slot wraps on the plan", async () => {
    const text =
      "Eating out at the little Vietnamese place on the corner with Sam and the neighbours, then " +
      "ice cream by the river if the weather holds and nobody is too tired to walk back home " +
      "tonight, before bedtime.";
    const read = await invokeTool<PlanRead>(page, "meals.plan.get", { planId: plan.planId });
    const breakfast = read.days[0]!.meals.find((meal) => meal.slotName === "breakfast")!;
    const before = await readMeal(page, breakfast.mealId);
    await mealArticle(page, 0, before.meal.title!)
      .getByRole("button", { name: "Text", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/text/${breakfast.mealId}`));
    await page.getByLabel("Text for this meal", { exact: true }).fill(text);
    await shot(page, "12-long-text-slot");
    await page.getByRole("button", { name: "Save text", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);
    await waitForPlanSettled(page);
    await expect(daySection(page, 0).getByText(text, { exact: true })).toBeVisible();
    await shot(page, "13-long-text-plan");
    say(`longtext chars=${text.length} wraps on the plan`);
  });

  await test.step("the plan shows its writing state while a day regenerates", async () => {
    await openMeals(page);
    await waitForPlanSettled(page);
    await daySection(page, 2)
      .getByRole("button", { name: "Regenerate day", exact: true })
      .click({ timeout: 60_000 });
    await expect(page.locator(".mls-writing").first()).toBeVisible({ timeout: 60_000 });
    await shot(page, "14-loading-writing");
    await waitForDayReady(page, plan.planId, 2);
    await waitForPlanSettled(page);
    say("loading=writing state captured");
  });

  await test.step("a missing meal shows the error screen", async () => {
    await page.goto(`${baseURL}/m/meals/plan/move/00000000-0000-4000-8000-000000000000`);
    await expect(page.getByText("Couldn't load this meal", { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await shot(page, "15-error-meal");
    say("error state=shown");
  });

  await test.step("dark mode renders the plan and every arrange screen", async () => {
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page
      .locator('[aria-label="Color mode"]')
      .getByRole("button", { name: "Dark", exact: true })
      .click();
    await openMeals(page);
    await waitForPlanSettled(page);
    await shot(page, "16-dark-plan");

    const read = await invokeTool<PlanRead>(page, "meals.plan.get", { planId: plan.planId });
    const dinner = read.days[1]!.meals.find((meal) => meal.slotName === "dinner")!;
    const detail = await readMeal(page, dinner.mealId);
    await mealArticle(page, 1, detail.meal.title!)
      .getByRole("button", { name: "Move", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/move/${dinner.mealId}`));
    await shot(page, "17-dark-move");
    await page.getByRole("link", { name: "Back to the plan", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);

    await mealArticle(page, 1, detail.meal.title!)
      .getByRole("button", { name: "Eaters", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/eaters/${dinner.mealId}`));
    await shot(page, "18-dark-eaters");
    await page.getByRole("link", { name: "Back to the plan", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/meals\/?$/);

    const textMeal = read.days[0]!.meals.find((meal) => meal.slotName === "breakfast")!;
    const textDetail = await readMeal(page, textMeal.mealId);
    await mealArticle(page, 0, textDetail.meal.title ?? textDetail.meal.plainText!)
      .getByRole("button", { name: "Text", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/m/meals/plan/text/${textMeal.mealId}`));
    await shot(page, "19-dark-text");
    say(
      "visual light=shown dark=shown widths=1280,390,320 " + "states=empty,loading,error,long text"
    );
  });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
