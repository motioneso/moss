import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1112: admin+data seeds the onboarding chunk as complete (tests/uat/seed/levels.ts), so a
// freshly-logged-in owner at this level lands directly on AppShell/Today — no wizard to dismiss.
export const uatLevel = { level: "admin+data", without: [] } as const;

// #1112: on the Today page masthead, the greeting ("Good morning/afternoon/evening, {name}",
// .cmd-eyebrow) and the dateline (.cmd-dateline) must read across the SAME top line — greeting
// left, date right. Before the fix, .cmd-eyebrow was a <p> carrying the UA default top margin,
// pushing the greeting ~1 line below the dateline despite .cmd-masthead__row's
// align-items: stretch top-aligning both columns. Proof: compare each element's bounding-box
// top against a real dev instance (no mocked layout/CSS — this is exactly the kind of visual
// regression unit tests/typecheck can't catch).
test("greeting and dateline share the same top line on the Today masthead", async ({ page }) => {
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

  // admin+data lands on Today (app.tsx's index route), the greeting/dateline live there.
  const greeting = page.locator(".jds-masthead__eyebrow");
  const dateline = page.locator(".jds-masthead__dateline");
  await expect(greeting).toBeVisible();
  await expect(dateline).toBeVisible();

  const [greetingBox, datelineBox] = await Promise.all([
    greeting.boundingBox(),
    dateline.boundingBox()
  ]);
  if (!greetingBox || !datelineBox) {
    throw new Error(
      "could not read bounding boxes for .jds-masthead__eyebrow / .jds-masthead__dateline"
    );
  }

  // Same top line: allow a small tolerance for sub-pixel/line-height rounding between the two
  // elements' distinct type (13px/700/0.18em uppercase on both, but a <p> vs a flush <div>).
  // Playwright's boundingBox() exposes the top edge as `.y` (not `.top`, which is a DOM
  // getBoundingClientRect() field) — reading `.top` here would be undefined -> NaN.
  expect(Math.abs(greetingBox.y - datelineBox.y)).toBeLessThanOrEqual(2);

  // Guard against a false pass where both boxes collapse to the same degenerate (0,0) origin.
  expect(greetingBox.y).toBeGreaterThan(0);
});

// #1412: packages/ui/src/masthead.tsx joined the title and accent spans with no whitespace
// node, so real headline text (e.g. "ONE" + "ON THE BOOKS") rendered as "ONEON THE BOOKS" in
// DOM text content — broken for copy/paste and screen readers, not just visually. Mode-agnostic:
// doesn't assume which today-labels.ts buildHeadline() branch the seed data lands on.
test("masthead title and accent are separated by a real space", async ({ page }) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  const titleEl = page.locator(".jds-masthead__title");
  await expect(titleEl).toBeVisible();

  const accentEl = titleEl.locator(".jds-masthead__accent");
  if ((await accentEl.count()) === 0) {
    // buildHeadline() has one branch with no accent; nothing to prove a space between.
    return;
  }

  const topText = (await titleEl.locator("> span").first().innerText()).trim();
  const accentText = (await accentEl.innerText()).trim();
  const fullText = (await titleEl.innerText()).trim();
  expect(fullText).toBe(`${topText} ${accentText}`);
});
