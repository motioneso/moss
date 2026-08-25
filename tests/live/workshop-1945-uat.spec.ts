// Live-Path Gate for #1945 — the Workshop page reads real build/module data, not placeholders.
// Runs against a REAL running dev instance: real API, real Postgres with RLS. Nothing is mocked.
// See docs/DEVELOPMENT_STANDARDS.md.
//
// Driving a brand-new AI chat build request end to end is #1888's live test
// (tests/live/workshop-1888-uat.spec.ts). This test only proves #1945's part: that the
// Workshop page fetches and renders whatever real builds/modules already exist for the
// signed-in user, instead of the old hardcoded empty page.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:5184 LIVE_API_URL=http://127.0.0.1:3033 \
//     npx playwright test --config playwright.live.config.ts workshop-1945
import { expect, test, type Page } from "@playwright/test";

const OWNER = { email: "ben@ben.com", password: "jarvistest123!" };

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

test("the Workshop page shows the signed-in user's real builds, not the empty state", async ({
  page
}) => {
  test.setTimeout(60_000);

  await signInThroughUi(page);
  await page.goto("/workshop");

  // This account already has real in-progress builds from earlier live runs, so the page
  // must show them, not the "nothing in the workshop yet" placeholder it showed before #1945.
  await expect(page.getByText(/nothing in the workshop yet/i)).toHaveCount(0);
  const needsYou = page.getByText("Needs you");
  const buildingNow = page.getByText("Building now");
  await expect(needsYou.or(buildingNow).first()).toBeVisible({ timeout: 15_000 });

  // "Live" group only asserted if the account already has an external module installed —
  // do not invent one just to exercise the badge.
  const liveGroup = page.getByText("Live", { exact: true });
  if (await liveGroup.count()) {
    const badge = page.getByText(/^Live · (you only|everyone)$/);
    await expect(badge.first()).toBeVisible();
  }
});
