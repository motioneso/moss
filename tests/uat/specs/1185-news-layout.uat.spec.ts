import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #1185: durable live-instance visual proof that the News mosaic renders both card variants —
// photo cards (image bound to its kicker) and no-photo/text-only cards (--textonly, no <img>) —
// against a real, prod-shaped instance. No frontend mocks: playwright.uat.config.ts has no
// webServer/routes, GET /api/news/overview enqueues a real news.refresh pg-boss job that fetches
// real RSS feeds (packages/news/src/source/catalog.ts). The topic prefs + AI→module.news binding
// are seeded by the admin+data level (seedNewsChunk/seedAiProviderChunk); the headline items,
// images, and photo/no-photo variance are all live, unmocked feed output — nothing is fabricated.

// The refresh runs async after the first GET, then RSS fetches take real wall-clock time, so we
// poll (reloading to force a fresh overview read) well past the 60s config default.
test.setTimeout(240_000);

const MOSAIC_CARD = "article.nw-mosaic__art";
const PHOTO_CARD = "article.nw-mosaic__art:has(img.nw-mosaic__img)";
const TEXTONLY_CARD = "article.nw-mosaic__art--textonly";

test("News mosaic renders live photo and no-photo card variants (#1185)", async ({ page }) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();

  // Poll the live page: reload every few seconds until the first news.refresh job has landed real
  // headlines AND the feed mix has produced both variants. Real RSS output is variable, so we wait
  // out the mix rather than assuming the first successful fetch shows both — this is the honest
  // acceptance point (#1185), not a fabricated dataset.
  const deadline = Date.now() + 180_000;
  let sawCards = false;
  let sawBothVariants = false;
  while (Date.now() < deadline) {
    await page.goto(`${baseURL}/news`);
    // Give the SPA a beat to fetch /api/news/overview and paint whatever the server has cached.
    await page
      .locator(MOSAIC_CARD)
      .first()
      .waitFor({ state: "visible", timeout: 8_000 })
      .catch(() => {});

    const photoCount = await page.locator(PHOTO_CARD).count();
    const textCount = await page.locator(TEXTONLY_CARD).count();
    if (photoCount + textCount > 0) sawCards = true;
    if (photoCount > 0 && textCount > 0) {
      sawBothVariants = true;
      break;
    }
  }

  if (!sawCards) {
    throw new Error(
      "News mosaic never rendered any cards within 180s — the live news.refresh job produced no " +
        "headlines. Not a layout regression; report as a real ingestion/timing finding."
    );
  }

  // Desktop assertion.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/news`);
  await expect(page.locator(MOSAIC_CARD).first()).toBeVisible({ timeout: 15_000 });

  // Narrow assertion.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/news`);
  await expect(page.locator(MOSAIC_CARD).first()).toBeVisible({ timeout: 15_000 });

  // The literal acceptance proof (#1185): at least one photo card AND at least one text-only card
  // in the live mosaic. If real feeds didn't yield both within the poll window above, this fails
  // honestly rather than padding data to force it.
  expect(
    sawBothVariants,
    "expected the live mosaic to show both a photo card and a no-photo (--textonly) card"
  ).toBe(true);
  await expect(page.locator(PHOTO_CARD).first()).toBeVisible();
  await expect(page.locator(TEXTONLY_CARD).first()).toBeVisible();
});
