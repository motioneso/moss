// Live-Path Gate for #3057 (decision-model presets), phase 3 of the plan.
//
// Real API, real worker, real database, real services. Nothing is intercepted or rewritten.
// Run on a scratch database with a fresh owner, in order, as one serial file. Each service is added
// through the Settings form, tested where the service allows it, bound to the Classifier row, then
// one real News relevance sort runs and the Activity history must name the model:
//   1. Any compatible service (Laya on this machine's CPU): added by address, model added by hand,
//      bound. No News sort, because CPU answers do not fit inside the 20 second request limit.
//   2. Clef.
//   3. Jev (TypeSafe).
// The chat tool-check path that also reads the Classifier row is not exercised here.
//
// Secrets are read from files at run time and never printed: the Cloudflare token and account id
// from ~/.config/clef, the Jev key from LIVE_JEV_KEY_FILE. Clef steps skip when the token file is
// absent. Screenshots are taken only after save, of the provider card or the result lines, so the
// account id and token never appear in a picture.
//
// Variables: LIVE_BASE_URL, LIVE_OWNER_EMAIL, LIVE_OWNER_PASSWORD, LIVE_R26_TOOL_SERVER (stand-in
// tool server), LIVE_R26_WORKER_LOG (worker log file), LIVE_R26_SHOT_DIR (picture folder),
// LIVE_COMPAT_URL (the compatible service address), LIVE_JEV_KEY_FILE (optional).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ListActivityLinesResponse } from "../../packages/shared/src/ai-activity-lines-api.js";
import type { ListAiModelsResponse } from "../../packages/shared/src/ai-api.js";
import { R26, signIn } from "./classifier-2984-r26-helpers.js";

const CLEF_DIR = join(homedir(), ".config", "clef");
const TOKEN_FILE = join(CLEF_DIR, "token");
const ACCOUNT_FILE = join(CLEF_DIR, "account-id");
const haveClef = existsSync(TOKEN_FILE) && existsSync(ACCOUNT_FILE);
const jevKeyFile = process.env.LIVE_JEV_KEY_FILE;
const compatUrl = process.env.LIVE_COMPAT_URL;
/** A compatible service is named by its address host. */
const compatName = compatUrl ? `Decision model (${new URL(compatUrl).host})` : "";

function secret(path: string): string {
  return readFileSync(path, "utf8").trim();
}

function shot(name: string): string {
  mkdirSync(R26.shotDir, { recursive: true });
  return `${R26.shotDir}/3057-${name}.png`;
}

async function openProviders(page: Page): Promise<void> {
  await page.goto("/settings?section=aiproviders");
  await expect(page.getByRole("button", { name: "Add provider" })).toBeVisible();
}

function providerCard(page: Page, name: string): Locator {
  return page.locator(".prov", { has: page.locator(".prov__name", { hasText: name }) }).first();
}

async function openAddForm(page: Page, choice: string): Promise<void> {
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.locator(".provpick__item", { hasText: choice }).click();
}

/** Presses Test on a provider card and returns the message the screen shows. */
async function pressTest(page: Page, name: string): Promise<string> {
  await providerCard(page, name)
    .locator(".prov__acts")
    .getByRole("button", { name: "Test" })
    .click();
  // Earlier toasts ("Added ...") can still be on screen, so wait for the Test result's own text.
  const result = page
    .locator(".set-toasts [role=status] *")
    .filter({ hasNotText: /^Added / })
    .filter({ hasText: /\S/ })
    .last();
  await expect(result).toBeVisible({ timeout: 60_000 });
  return ((await result.textContent()) ?? "").trim();
}

async function modelsOf(page: Page, providerName: string) {
  const providers = (await (await page.request.get("/api/ai/providers")).json()) as {
    providers: { id: string; displayName: string }[];
  };
  const id = providers.providers.find((p) => p.displayName === providerName)?.id;
  const models = (await (await page.request.get("/api/ai/models")).json()) as ListAiModelsResponse;
  return models.models.filter((m) => m.providerConfigId === id);
}

/** Chooses a model in the Classifier row's picker, through the screen. */
async function bindClassifier(page: Page, providerName: string, modelLabel: RegExp) {
  await openProviders(page);
  const picker = page.getByLabel("Classifier model");
  const value = await picker
    .locator(`optgroup[label="${providerName}"] option`)
    .filter({ hasText: modelLabel })
    .first()
    .getAttribute("value");
  expect(
    value,
    `${providerName} has a model matching ${modelLabel} in the Classifier picker`
  ).toBeTruthy();
  await picker.selectOption(value!);
  await expect(picker).toHaveValue(value!);
  await page.waitForTimeout(1_000);
}

/**
 * Saves one "Less like this" with a reason on a real front-page story. That saves a reading rule and
 * recompiles News, which asks the Classifier row's model to judge the stories against the rule.
 */
async function sortNews(page: Page, reason: string): Promise<void> {
  const menu = page.getByRole("button", { name: /^Feedback for / }).first();
  // A story only offers feedback once the first compiled snapshot exists, so reload until it does.
  await expect(async () => {
    await page.goto("/news");
    await expect(menu).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000] });
  await menu.click();
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  await page.getByLabel("Why less like this?").fill(reason);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Why less like this?")).toHaveCount(0, { timeout: 30_000 });
}

async function activityLines(page: Page) {
  const response = await page.request.get("/api/ai/activity-lines?limit=200");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as ListActivityLinesResponse).entries;
}

/** Waits for an Activity line that names the model, and returns it. */
async function lineFor(page: Page, modelName: RegExp) {
  let found;
  await expect
    .poll(
      async () => {
        found = (await activityLines(page)).find((line) => modelName.test(line.modelName));
        return found?.modelName ?? null;
      },
      { timeout: 120_000, intervals: [3_000] }
    )
    .not.toBeNull();
  return found!;
}

async function showActivity(page: Page, modelName: RegExp, name: string): Promise<void> {
  await page.goto("/settings?section=activity");
  const line = page.locator(".act-line", { hasText: modelName }).first();
  await expect(line).toBeVisible({ timeout: 30_000 });
  await line.screenshot({ path: shot(name) });
}

test.describe.configure({ mode: "serial" });

test("owner account", async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();
  await page.getByLabel("Name").fill("Proof owner");
  await page.getByLabel("Email").fill(R26.ownerEmail);
  await page.getByLabel("Password").fill(R26.ownerPassword);
  await page.locator("form").getByRole("button", { name: "Create account" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  await expect(skipSetup.or(page.getByRole("navigation").first()).first()).toBeVisible({
    timeout: 30_000
  });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
});

test("Any compatible service: add by address, add the model by hand, bound to the Classifier row", async ({
  page
}) => {
  test.skip(!compatUrl, "no compatible service address given");
  test.setTimeout(900_000);
  await signIn(page);
  await openProviders(page);
  // The earlier presets are added, and this one still offers itself.
  await openAddForm(page, "Any compatible service");
  await page.locator(".provpick").getByLabel("Address").fill(compatUrl!);
  await page.locator(".provpick").getByLabel("API key").fill("unused-by-this-server");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const card = providerCard(page, compatName);
  await expect(card).toBeVisible({ timeout: 60_000 });

  // The service lists no models, so Test says so instead of blaming the key.
  const message = await pressTest(page, compatName);
  console.log("Compatible Test message:", message);
  expect(message).toContain("does not list its models");

  await card.getByRole("button", { name: "Add model" }).click();
  await card.getByLabel("Model id").fill("typed-decisions");
  await card.getByLabel("Display name").fill("Laya typed-decisions");
  // The form already ticks the decision-model defaults for this provider.
  await expect(card.getByRole("checkbox", { name: /json/i })).toBeChecked();
  await card.getByRole("button", { name: "Add model", exact: true }).last().click();
  await expect(card.getByRole("button", { name: "Edit Laya typed-decisions" })).toBeVisible({
    timeout: 30_000
  });
  await card.screenshot({ path: shot("6-compatible-added") });

  await bindClassifier(page, compatName, /Laya typed-decisions/);
  // The News sort is not run here. A CPU-only Laya takes about 3 seconds per question, a News
  // batch asks one per story, and the request limit is 20 seconds, so the batch always times out.
  await card.screenshot({ path: shot("7-compatible-bound") });
});

test("Clef: add, test, bind to the Classifier row, sort, Activity names the model", async ({
  page
}) => {
  test.skip(!haveClef, "no Cloudflare token file on this machine");
  test.setTimeout(900_000);
  await signIn(page);
  await openProviders(page);
  await expect(page.locator(".provpick__item", { hasText: "Clef (Cloudflare)" })).toHaveCount(0);
  await openAddForm(page, "Clef (Cloudflare)");
  await page.locator(".provpick").getByLabel("Account ID").fill(secret(ACCOUNT_FILE));
  await page.locator(".provpick").getByLabel("API token").fill(secret(TOKEN_FILE));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const card = providerCard(page, "Clef (Cloudflare)");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.screenshot({ path: shot("1-clef-added") });

  const message = await pressTest(page, "Clef (Cloudflare)");
  console.log("Clef Test message:", message);
  expect(message).toBe("Provider credential is valid.");

  await expect
    .poll(
      async () => (await modelsOf(page, "Clef (Cloudflare)")).map((m) => m.providerModelId).sort(),
      {
        timeout: 60_000
      }
    )
    .toEqual(["clef", "clef-flash"]);
  const [flash] = (await modelsOf(page, "Clef (Cloudflare)")).filter(
    (m) => m.providerModelId === "clef-flash"
  );
  expect(flash!.capabilities).toContain("json");

  await bindClassifier(page, "Clef (Cloudflare)", /clef-flash/i);
  await page
    .getByLabel("Classifier model")
    .locator("xpath=ancestor::div[@class='rt'][1]")
    .screenshot({
      path: shot("2-clef-flash-bound")
    });

  await sortNews(page, "I do not want politics or election coverage.");

  const line = await lineFor(page, /clef-flash/i);
  console.log(
    "Clef Activity line:",
    JSON.stringify({ model: line.modelName, outcome: line.outcome })
  );
  expect(line.outcome).toBe("ok");
  await showActivity(page, /clef-flash/i, "3-clef-activity");
});

test("Jev (TypeSafe): still added through the form, bound, and sorting News", async ({ page }) => {
  test.skip(!jevKeyFile || !existsSync(jevKeyFile), "no Jev key file given");
  test.setTimeout(900_000);
  await signIn(page);
  await openProviders(page);
  await openAddForm(page, "Jev (TypeSafe)");
  await page.locator(".provpick").getByLabel("API key").fill(secret(jevKeyFile!));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const card = providerCard(page, "Jev (TypeSafe)");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.screenshot({ path: shot("4-jev-added") });

  expect(await pressTest(page, "Jev (TypeSafe)")).toBe("Provider credential is valid.");
  const models = await modelsOf(page, "Jev (TypeSafe)");
  expect(models.length).toBeGreaterThan(0);
  const jevName = new RegExp(models[0]!.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  await bindClassifier(page, "Jev (TypeSafe)", jevName);
  await sortNews(page, "I do not want sports results or match reports.");
  const line = await lineFor(page, jevName);
  console.log(
    "Jev Activity line:",
    JSON.stringify({ model: line.modelName, outcome: line.outcome })
  );
  expect(line.outcome).toBe("ok");
  await showActivity(page, jevName, "5-jev-activity");
});
