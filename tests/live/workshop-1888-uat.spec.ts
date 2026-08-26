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
const ASK = [
  "Please build me a new module.",
  "It should keep a list of my houseplants and remind me when each one needs watering.",
  "It only needs its own data - it does not need email, calendar, or anything external.",
  "It should run once a day in the morning.",
  "Go ahead and start the build now and show me the plan."
].join(" ");

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

test("asking Moss for a module in the chat drawer returns a plan for approval", async ({
  page
}) => {
  test.setTimeout(600_000);

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

  await composer.fill(ASK);
  await composer.press("Enter");

  await expect(planCards).toHaveCount(1, { timeout: 240_000 });

  // #1949 Phase 1: approving the plan takes you straight to the Workshop page, the chat
  // drawer stays open behind it, the build's status text changes at least once while it
  // runs, and a notification shows up once it finishes or fails.
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

  // Wait for the build to actually leave the "Building now" group (finished or failed) before
  // loading /notifications - that page only fetches its list once, on mount, so navigating there
  // while the build is still running and then waiting on the DOM would never see a notification
  // created after the page already loaded.
  await expect(statusIndicator).toHaveCount(0, { timeout: 240_000 });

  await page.goto("/notifications");
  const buildNotification = page.getByText(
    /^Your module is ready for a look$|^Your module build failed$/
  );
  await expect(buildNotification.first()).toBeVisible({ timeout: 30_000 });
});
