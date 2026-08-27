// Live-Path Gate for #1888 — asking Moss for a module in chat and getting a plan back.
// Runs against a REAL running dev instance: real API, real Postgres with RLS, real chat
// engine and a real AI provider. Nothing is mocked. See docs/DEVELOPMENT_STANDARDS.md.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:5184 LIVE_API_URL=http://127.0.0.1:3033 \
//     npx playwright test --config playwright.live.config.ts workshop-1888
import { expect, test, type Page } from "@playwright/test";

const OWNER = { email: "ben@ben.com", password: "jarvistest123!" };

// One message that supplies everything workshop.buildModule's description tells the model to
// gather first (what it does, what it reaches, when it runs), so the turn reaches the tool
// instead of spending itself on follow-up questions.
test.describe.configure({ mode: "serial" });

async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(OWNER.email);
  await page.getByLabel(/password/i).fill(OWNER.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

test("Moss builds and installs a working Word of the Day module through the UI", async ({
  page
}) => {
  test.setTimeout(1_800_000);
  const requestedModuleId = `word-of-day-${Date.now().toString().slice(-8)}`;
  const ask = [
    `Please build a new module with the exact id ${requestedModuleId}.`,
    "Call it Word of the Day.",
    "Its page should show one word, its definition, and today's date, choosing deterministically from a small built-in list.",
    "It needs no database, email, calendar, network access, credentials, background jobs, or anything external.",
    "It runs whenever I open its page.",
    "Use the existing Moss design-system classes and include a clear Word of the Day heading.",
    "Go ahead and show me the plan."
  ].join(" ");

  await signInThroughUi(page);

  await page.getByRole("button", { name: /^(Chat with .+|Open chat)$/ }).click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeVisible();

  // #1943: start a fresh conversation before asking. The drawer reopens the previous one, and
  // both of the ways that broke this test come from that history. The old plan is still in it,
  // so Moss reasonably answers "that plan is already waiting on you" and never calls the tool
  // again; and the words "Build it" are already on the page, in the old card and in Moss's own
  // prose, so waiting for them to appear passed in under two seconds against a branch where
  // nothing had happened - no new build record, no new entry in the tool audit log.
  await page.getByRole("button", { name: /^New chat$/ }).click();

  // Exactly one card, and only after the ask, so neither a leftover card nor a polite refusal
  // nor a follow-up question can pass this.
  const planCards = page.getByRole("button", { name: /^Build it$/ });
  await expect(planCards).toHaveCount(0);

  await composer.fill(ask);
  await composer.press("Enter");

  await expect(planCards).toHaveCount(1, { timeout: 240_000 });

  // Approving takes us to the Workshop and starts real worker progress.
  await planCards.click();

  await expect(page).toHaveURL(/\/workshop$/, { timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: /^Chat with .+|^Chat$/ })).toBeVisible();

  const statusIndicator = page
    .locator(".jds-indicator.jds-indicator--live")
    .filter({ hasText: /.+/ })
    .first();
  await expect(statusIndicator).toBeVisible({ timeout: 30_000 });
  const firstStatus = (await statusIndicator.textContent())?.trim();
  await expect(async () => {
    const current = (await statusIndicator.textContent())?.trim();
    expect(current).not.toBe(firstStatus);
  }).toPass({ timeout: 240_000, intervals: [3_000] });

  await expect(statusIndicator).toHaveCount(0, { timeout: 1_650_000 });

  // A failure cannot pass: the final worker step must have installed a draft and persisted
  // its module id before this action exists.
  const lookAtDraft = page.getByRole("button", { name: "Look at the draft" }).first();
  await expect(lookAtDraft).toBeVisible({
    timeout: 30_000
  });
  await lookAtDraft.click();

  await expect(page).toHaveURL(/\/m\/[a-z0-9-]+$/, { timeout: 30_000 });
  const installedModuleId = new URL(page.url()).pathname.split("/").at(-1);
  expect(installedModuleId).toBeTruthy();
  const moduleRoot = page.locator(`[data-module="${installedModuleId}"]`);
  await expect(moduleRoot).toBeVisible({ timeout: 30_000 });
  await expect(moduleRoot.getByText(/word of the day/i).first()).toBeVisible();
  await expect(moduleRoot.getByText(/noun|verb|adjective|adverb/i).first()).toBeVisible();

  // The draft's real host actions work too: asking opens chat, and shipping changes the
  // persisted draft state rather than merely changing button copy.
  await page.getByRole("button", { name: "Ask for a change" }).click();
  await expect(page.getByRole("dialog", { name: /^Chat with .+|^Chat$/ })).toBeVisible();
  await page.getByRole("button", { name: "Ship it" }).click();
  await expect(page.getByRole("button", { name: "Ship it" })).toHaveCount(0);

  await page.reload();
  await expect(page.locator(`[data-module="${installedModuleId}"]`)).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByRole("button", { name: "Ship it" })).toHaveCount(0);
  await page.goto("/workshop");
  await expect(page.getByRole("button", { name: "Look at the draft" })).toHaveCount(0);
});
