import { expect, test, type Page } from "@playwright/test";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

export const uatLevel = {
  level: "multi-user",
  without: [],
  withSportsPublicSourceFixtures: true
} as const;

interface SportsOverview {
  readonly topStories: ReadonlyArray<{ readonly storyRef?: string; readonly title: string }>;
}

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(
  page: Page,
  credentials = { email: UAT_ADMIN_EMAIL, password: UAT_ADMIN_PASSWORD }
): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

function isSportsOverview(response: { url(): string; request(): { method(): string } }): boolean {
  return (
    new URL(response.url()).pathname === "/api/sports/overview" &&
    response.request().method() === "GET"
  );
}

async function openSportsPage(page: Page): Promise<SportsOverview> {
  const responsePromise = page.waitForResponse(isSportsOverview);
  await page.goto(`${requireBaseURL()}/sports`);
  const overview = (await (await responsePromise).json()) as SportsOverview;
  const trigger = page.getByRole("button", { name: "Story feedback" }).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "More like this" })).toBeVisible();
  return overview;
}

async function openTodayWidget(page: Page): Promise<SportsOverview> {
  await page.goto(`${requireBaseURL()}/today`);
  const responsePromise = page.waitForResponse(isSportsOverview);
  await page.reload();
  const overview = (await (await responsePromise).json()) as SportsOverview;
  await expect(page.getByRole("region", { name: "Sports desk" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Story feedback" }).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menuitem", { name: "More like this" })).toBeVisible();
  return overview;
}

async function saveLessLikeThis(page: Page, reason: string): Promise<SportsOverview> {
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  const editor = page.getByRole("dialog", { name: "Why less like this?" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Tell us why before saving.")).toBeVisible();
  await editor.getByRole("textbox", { name: "Why less like this?" }).fill(reason);
  const saveResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/me/usefulness-feedback" &&
      response.request().method() === "POST"
  );
  const responsePromise = page.waitForResponse(isSportsOverview);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  const [saveResponse, overviewResponse] = await Promise.all([
    saveResponsePromise,
    responsePromise
  ]);
  expect(saveResponse.ok()).toBe(true);
  return (await overviewResponse.json()) as SportsOverview;
}

async function saveMoreLikeThis(page: Page): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/me/usefulness-feedback" &&
      response.request().method() === "POST"
  );
  await page.getByRole("menuitem", { name: "More like this" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
}

async function assertRemovedAndReplaced(
  page: Page,
  before: SportsOverview,
  after: SportsOverview,
  title: string
): Promise<void> {
  const beforeRefs = new Set(
    before.topStories.flatMap((story) => (story.storyRef ? [story.storyRef] : []))
  );
  const afterRefs = new Set(
    after.topStories.flatMap((story) => (story.storyRef ? [story.storyRef] : []))
  );
  expect(afterRefs).not.toContain(before.topStories[0]?.storyRef);
  expect(after.topStories.length).toBeGreaterThan(0);
  expect([...afterRefs].some((storyRef) => !beforeRefs.has(storyRef))).toBe(true);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Story feedback" }).first()).toBeVisible();
  console.log(`[live proof] removed "${title}" and showed a replacement story`);
}

test.describe.configure({ mode: "serial" });

test("edits and removes a Less like this preference in Sports Settings", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const sportsBefore = await openSportsPage(page);
  const sportsStory = sportsBefore.topStories[0];
  expect(sportsStory?.storyRef).toBeTruthy();
  expect(sportsStory?.title).toBeTruthy();
  const sportsAfter = await saveLessLikeThis(page, "Too much of this coverage");
  await assertRemovedAndReplaced(page, sportsBefore, sportsAfter, sportsStory!.title);
  console.log("[live proof] empty reason was rejected, then Sports saved the real reason");

  const sportsReloadResponse = page.waitForResponse(isSportsOverview);
  await page.reload();
  const sportsReloaded = (await (await sportsReloadResponse).json()) as SportsOverview;
  expect(sportsReloaded.topStories.some((story) => story.storyRef === sportsStory!.storyRef)).toBe(
    false
  );
  await expect(page.getByText(sportsStory!.title, { exact: true })).toHaveCount(0);
  console.log("[live proof] the removed Sports story stayed hidden after reload");

  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const preferences = page.locator('section[aria-label="Story preferences"]');
  await expect(preferences).toBeVisible();
  await expect(preferences).toContainText("Less");
  await expect(preferences).toContainText("Too much of this coverage");

  const row = preferences
    .locator(".sp-feedback-settings__row")
    .filter({ hasText: "Too much of this coverage" });
  await row.getByRole("button", { name: "Edit reason" }).click();
  const reason = row.getByRole("textbox", { name: /Reason for/ });
  await reason.fill("Updated Sports reason");
  await row.getByRole("button", { name: "Save" }).click();
  const updatedRow = preferences
    .locator(".sp-feedback-settings__row")
    .filter({ hasText: "Updated Sports reason" });
  await expect(updatedRow.getByRole("button", { name: "Edit reason" })).toBeVisible();
  await updatedRow.getByRole("button", { name: "Remove" }).click();
  await expect(updatedRow).toHaveCount(0);
  console.log("[live proof] Sports Settings edited and removed the preference");

  const restoredSportsResponse = page.waitForResponse(isSportsOverview);
  await page.goto(`${requireBaseURL()}/sports`);
  const restoredSports = (await (await restoredSportsResponse).json()) as SportsOverview;
  expect(restoredSports.topStories.some((story) => story.storyRef === sportsStory!.storyRef)).toBe(
    true
  );
  await expect(
    page.locator(".sp-hero__link").filter({ hasText: sportsStory!.title })
  ).toBeVisible();
  console.log("[live proof] removing the Sports preference restored story eligibility");

  const todayBefore = await openTodayWidget(page);
  const todayStory = todayBefore.topStories[0];
  expect(todayStory?.storyRef).toBeTruthy();
  expect(todayStory?.title).toBeTruthy();
  const todayAfter = await saveLessLikeThis(page, "Too much from the Today desk");
  await assertRemovedAndReplaced(page, todayBefore, todayAfter, todayStory!.title);
  console.log("[live proof] the same empty-reason and real-reason flow worked from Today");

  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("form.auth-form")).toBeVisible();
  await signIn(page, { email: UAT_SECOND_OWNER_EMAIL, password: UAT_SECOND_OWNER_PASSWORD });

  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  // With no saved preferences the section is not rendered at all (Ben, 2026-09-03).
  const secondOwnerPreferences = page.locator('section[aria-label="Story preferences"]');
  await expect(page.getByRole("heading", { name: "News sources" })).toBeVisible();
  await expect(secondOwnerPreferences).toHaveCount(0);
  await expect(
    secondOwnerPreferences.getByText("Too much from the Today desk", { exact: true })
  ).toHaveCount(0);
  console.log("[live proof] the second user could not see the first user's Sports preference");

  await page.goto(`${requireBaseURL()}/sports`);
  const secondOwnerStoryMenu = page
    .getByRole("button", { name: "Story feedback" })
    .filter({ visible: true })
    .first();
  await expect(secondOwnerStoryMenu).toBeVisible();
  await secondOwnerStoryMenu.click();
  await saveMoreLikeThis(page);
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  await expect(
    page.locator('section[aria-label="Story preferences"]').getByText("More", { exact: true })
  ).toBeVisible();
  console.log("[live proof] the second user made a separate choice on a visible Sports story");

  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("form.auth-form")).toBeVisible();
  await signIn(page);
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const firstOwnerPreferences = page.locator('section[aria-label="Story preferences"]');
  await expect(
    firstOwnerPreferences.getByText("Too much from the Today desk", { exact: true })
  ).toBeVisible();
  console.log(
    "[live proof] the first user's preference stayed unchanged after the second user's action"
  );
});
