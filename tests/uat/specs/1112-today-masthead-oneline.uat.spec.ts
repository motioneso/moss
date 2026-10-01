import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1112: admin+data seeds the onboarding chunk as complete (tests/uat/seed/levels.ts), so a
// freshly-logged-in owner at this level lands directly on AppShell/Today — no wizard to dismiss.
export const uatLevel = { level: "admin+data", without: [] } as const;

// #1112: the Today greeting (.today-hero__eyebrow) must sit flush at the top of the hero band,
// directly above the headline. Originally the eyebrow was a <p> carrying the UA default top
// margin, pushing the greeting a full line below where the masthead placed the date. The masthead
// and its side-by-side dateline were replaced by the hero band (the date now heads the "Your day"
// section), so the same bug class shows up as a stray gap above or below the eyebrow. Proof:
// bounding boxes on a real instance, no mocked layout/CSS.
test("greeting sits flush at the top of the Today hero, right above the headline", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);

  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  // admin+data lands on Today (app.tsx's index route), the hero lives there.
  const hero = page.locator(".today-hero");
  const greeting = hero.locator(".today-hero__eyebrow");
  const title = hero.locator(".today-hero__title");
  await expect(greeting).toBeVisible();
  await expect(title).toBeVisible();

  const [heroBox, greetingBox, titleBox] = await Promise.all([
    hero.boundingBox(),
    greeting.boundingBox(),
    title.boundingBox()
  ]);
  if (!heroBox || !greetingBox || !titleBox) {
    throw new Error("could not read bounding boxes for .today-hero / eyebrow / title");
  }

  // kit-today-hero.css gives the hero 29px top padding and the eyebrow a 23px bottom margin in
  // day and evening mode (10px otherwise).
  // A stray UA <p> margin (~12px+) would break either bound; the slack covers sub-pixel rounding.
  const topGap = greetingBox.y - heroBox.y;
  expect(topGap).toBeGreaterThanOrEqual(0);
  expect(topGap).toBeLessThanOrEqual(36);

  const gapToTitle = titleBox.y - (greetingBox.y + greetingBox.height);
  expect(gapToTitle).toBeGreaterThanOrEqual(0);
  expect(gapToTitle).toBeLessThanOrEqual(26);

  // Guard against a false pass where every box collapses to the same degenerate origin.
  expect(greetingBox.height).toBeGreaterThan(0);
  expect(greetingBox.y).toBeGreaterThan(0);
});

// #1412: the headline (formerly the masthead component) joined the title and accent spans with no whitespace
// node, so real headline text (e.g. "ONE" + "ON THE BOOKS") rendered as "ONEON THE BOOKS" in
// DOM text content — broken for copy/paste and screen readers, not just visually.
//
// The accent is required, not optional, at this seed level: tests/uat/seed/chunks/tasks.ts seeds
// a task due before UAT_SEED_BASE_TIMESTAMP (tests/uat/seed/timestamps.ts), which is always in
// the past relative to real wall-clock time, so isAtRisk()/needsYou stays > 0 forever and
// apps/web/src/today/today-labels.ts buildHeadline() has no branch that returns an empty accent
// at admin+data — every path (evening/needsYou/eventsLeft/default) sets a non-empty accent
// string. A missing accent element here means the fix regressed or the seed data changed
// underneath this test, not a legitimate "no accent" state — fail loudly instead of skipping.
test("hero title and accent are separated by a real space", async ({ page }) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  const titleEl = page.locator(".today-hero__title");
  await expect(titleEl).toBeVisible();

  const accentEl = titleEl.locator(".today-hero__accent");
  await expect(accentEl).toHaveCount(1);

  // Read all three strings from a single DOM snapshot via one evaluate() round-trip, not three
  // separate awaited Playwright calls. The headline text is live (needsYou/eventsLeft counts
  // resolve async), so three sequential reads can straddle a re-render — e.g. topText captured
  // pre-resolve ("ALL CLEAR") while accentText/fullText are captured post-resolve ("NEED YOU" /
  // "EIGHT NEED YOU"), failing on a state race that has nothing to do with the #1412 whitespace
  // bug this test guards. A single evaluate() reads top/accent/full from the same frame, so the
  // comparison always reflects one consistent render.
  const { topText, accentText, fullText } = await titleEl.evaluate((titleNode) => {
    const topSpan = titleNode.querySelector(":scope > span:not(.today-hero__accent)");
    const accentSpan = titleNode.querySelector(":scope > span.today-hero__accent");
    return {
      topText: (topSpan?.textContent ?? "").trim(),
      accentText: (accentSpan?.textContent ?? "").trim(),
      fullText: (titleNode.textContent ?? "").trim()
    };
  });

  expect(fullText).toBe(`${topText} ${accentText}`);
});
