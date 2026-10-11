import { expect, test, type Locator, type Page } from "@playwright/test";
import type { NewsOverviewResponse } from "@moss/shared";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Provider fixtures run behind the real API. No browser routes or injected responses.
// News opts into declared synthetic RSS/model inputs compiled at seed time through the
// production compiler and actor-scoped repository/CAS. The real overview registers targets.
// This proves feedback UI/API persistence, not production AI routing or live refresh discovery.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withEspnFixture: true,
  withNewsFeedbackFixture: true
} as const;
test.setTimeout(300_000);

function baseURL() {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

async function signIn(page: Page) {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const account = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(account).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(account).toBeVisible();
}

function feedbackWrite(page: Page, method: "POST" | "PATCH", suffix = "") {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/api/me/usefulness-feedback") &&
      response.request().method() === method &&
      response.url().endsWith(suffix)
  );
}

async function registeredStory(page: Page) {
  const overviewResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/news/overview" &&
      response.request().method() === "GET"
  );
  await page.goto(`${baseURL()}/news`);
  const response = await overviewResponse;
  expect(response.status()).toBe(200);
  const overview = (await response.json()) as NewsOverviewResponse;
  const story = overview.rankedStories?.find((item) =>
    /^Declared synthetic audit story \d+$/.test(item.title)
  );
  expect(story, "Seeded compiler output must reach the real News overview").toBeDefined();
  expect(story?.feedbackRef, "The real overview must register a feedback target").toBeTruthy();
  const title = story!.title;
  await expect(page.getByRole("button", { name: `Feedback for ${title}` }).first()).toBeVisible();
  return title;
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
}

test("News saves curated choices and retains feedback outcomes through dismissal and removal", async ({
  page
}) => {
  await signIn(page);
  await page.goto(`${baseURL()}/settings?section=modules&module=news`);
  const topics = page.getByRole("region", { name: "Topics", exact: true });
  const topic = topics.locator("button[aria-pressed]").first();
  await expect(topic).toBeEnabled();
  const before = await topic.getAttribute("aria-pressed");
  const label = await topic.innerText();
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/api/news/prefs") &&
      ["POST", "DELETE"].includes(response.request().method())
  );
  await topic.click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "Preferences saved." })).toBeVisible();
  await expect(topic).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  await page.reload();
  await expect(topics.getByRole("button", { name: label, exact: true })).toHaveAttribute(
    "aria-pressed",
    before === "true" ? "false" : "true"
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noPageOverflow(page);
  }

  const title = await registeredStory(page);
  const menu = page.getByRole("button", { name: `Feedback for ${title}` }).first();
  await menu.click();
  const positive = feedbackWrite(page, "POST");
  await page.getByRole("menuitem", { name: "More like this" }).click();
  expect((await positive).status()).toBe(201);
  await expect(page.getByRole("status").filter({ hasText: "Preference saved." })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  const reason = page.getByLabel("Why less like this?");
  await reason.fill("Prefer a different angle.");
  await reason.press("Escape");
  await expect(reason).toHaveCount(0);
  await menu.click();
  await page.getByRole("menuitem", { name: "Less like this" }).click();
  await expect(reason).toHaveValue("Prefer a different angle.");
  const negative = feedbackWrite(page, "POST");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await negative).status()).toBe(201);
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Preference saved." })).toBeVisible();

  await page.goto(`${baseURL()}/settings?section=modules&module=news`);
  const section = page.getByRole("region", { name: "Story preferences", exact: true });
  const row = section.locator("li").filter({ hasText: title });
  await row.getByRole("button", { name: "Edit reason" }).click();
  await row.getByLabel("Reason", { exact: true }).fill("Updated different angle.");
  const edit = feedbackWrite(page, "PATCH");
  await row.getByRole("button", { name: "Save reason" }).click();
  expect((await edit).ok()).toBe(true);
  await expect(section.getByRole("status").filter({ hasText: "Reason saved" })).toBeVisible();
  await expect(row).toContainText("Updated different angle.");
  const remove = feedbackWrite(page, "POST", "/undo");
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  expect((await remove).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(section.getByRole("status").filter({ hasText: "Preference removed" })).toBeVisible();
  console.log(
    "[feedback UI proof] Declared synthetic RSS/model inputs used the production compiler and owner-scoped repository/CAS; the real overview registered targets and feedback saved, dismissed, edited and removed through the real UI. This does not prove production AI routing or live refresh discovery."
  );
});

async function activeSlide(carousel: Locator) {
  return carousel.locator('[data-active="true"], .sp-carousel__slide--active').innerText();
}

test("Sports retains pause through mixed input, manual selection and live reduced motion", async ({
  page
}) => {
  await signIn(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${baseURL()}/sports`);
  const carousel = page.locator('section[aria-roledescription="carousel"]').first();
  await expect(carousel.getByRole("button", { name: "Pause rotation", exact: true })).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noPageOverflow(page);
    await expect(
      carousel.getByRole("button", { name: "Pause rotation", exact: true })
    ).toBeInViewport();
  }
  await carousel.getByRole("button", { name: "Pause rotation", exact: true }).click();
  const next = carousel.getByRole("button", { name: /^Next (story|game)$/ });
  const first = await activeSlide(carousel);
  await next.click();
  await expect.poll(() => activeSlide(carousel)).not.toBe(first);
  const manuallySelected = await activeSlide(carousel);
  await carousel.hover();
  await next.focus();
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).focus();
  // Longer than either carousel's rotation interval; an explicit stop must survive departure.
  await page.waitForTimeout(10_000);
  expect(await activeSlide(carousel)).toBe(manuallySelected);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(carousel.getByRole("status")).toHaveText("Rotation is off for reduced motion.");
  await expect(
    carousel.getByRole("button", { name: "Resume rotation", exact: true })
  ).toBeDisabled();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    carousel.getByRole("button", { name: "Resume rotation", exact: true })
  ).toBeEnabled();
  await page.waitForTimeout(10_000);
  expect(await activeSlide(carousel)).toBe(manuallySelected);
  // Resume runs rotation while the pointer and focus stay on the Resume button.
  await carousel.getByRole("button", { name: "Resume rotation", exact: true }).click();
  await expect.poll(() => activeSlide(carousel), { timeout: 12_000 }).not.toBe(manuallySelected);
  console.log(
    "[live proof] Sports rotation stayed paused after manual selection, Resume restarted it with pointer and focus still inside; reduced motion changed live and preserved the user stop"
  );
});
