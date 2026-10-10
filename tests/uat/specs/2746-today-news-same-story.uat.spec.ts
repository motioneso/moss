import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2746: durable live-instance proof that Today's news desk merges the same story across
// outlets. withEspnFixture serves one fixed set of stories to every default catalog source
// (bbc, guardian, ap, nytimes), so before the fix the top story would repeat once per outlet;
// withoutNewsJsonBinding forces the live-fetch path this fix changed (composeOverview), not the
// pre-compiled personalized snapshot.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  withEspnFixture: true
} as const;

test.setTimeout(180_000);

// One of the four fixture stories (tests/uat/fixtures/espn-fixture-routes.ts); served identically
// to every outlet, so it is the case that would have shown up several times before the fix.
const SHARED_STORY_TITLE = "UAT rig achieves deterministic Tuesday";

const NEWS_TITLE = ".nw-twlead__title, .nw-twlist__title";

async function newsDeskTitles(page: Page): Promise<string[]> {
  await page.goto("/");
  await expect(page.locator(NEWS_TITLE).first()).toBeVisible({ timeout: 30_000 });
  return page.locator(NEWS_TITLE).allTextContents();
}

test("Today's news desk shows a story shared by several outlets only once (#2746)", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();

  // A weather lookup failure must not stop the page, or the rest of Today, from rendering.
  // The news desk is its own module widget behind its own error boundary and its own query,
  // independent of the weather query, so it renders regardless of whether weather loaded.
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 375, height: 812 }
  ]) {
    await page.setViewportSize(viewport);
    const titles = await newsDeskTitles(page);
    const occurrences = titles.filter((title) => title.trim() === SHARED_STORY_TITLE).length;
    expect(
      occurrences,
      `expected "${SHARED_STORY_TITLE}" to appear once in Today's news desk at ${viewport.width}px, ` +
        `got ${occurrences} (titles seen: ${JSON.stringify(titles)})`
    ).toBe(1);
  }
});
