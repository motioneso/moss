// Live-Path Gate for #1888 — asking Moss for a module in chat and getting a plan back.
// Runs against a REAL running dev instance: real API, real Postgres with RLS, real chat
// engine and a real AI provider. Nothing is mocked. See docs/DEVELOPMENT_STANDARDS.md.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:5174 LIVE_API_URL=http://127.0.0.1:3033 \
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
  test.setTimeout(300_000);

  await signInThroughUi(page);

  await page.getByRole("button", { name: /^(Chat with .+|Open chat)$/ }).click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeVisible();

  await composer.fill(ASK);
  await composer.press("Enter");

  // The plan card IS the approval gate. Wait for it rather than for any assistant text, so a
  // polite "I couldn't do that" cannot pass.
  await expect(page.getByText(/Build it/i).first()).toBeVisible({ timeout: 240_000 });
});
