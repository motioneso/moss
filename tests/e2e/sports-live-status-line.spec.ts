import { expect, test, type Page } from "@playwright/test";
import type { SportsOverviewResponse } from "@moss/shared";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import { registerMockSportsRoutes, sportsOverviewFixture } from "./mock-sports-api.js";

/**
 * #2753 — the live footer under a followed team's score now carries the game's quarter/period/
 * inning and clock, so it matches the height of the Next-game footer it sits beside. Proves both
 * surfaces (Sports, Today), both widths (desktop 1440, phone 375), and writes a picture of each
 * to tests/screenshots/ for a reviewer.
 */

const OVERVIEW: SportsOverviewResponse = {
  ...sportsOverviewFixture,
  followed: sportsOverviewFixture.followed.map((card) =>
    card.teamKey === "min" ? { ...card, liveStatusText: "Q3 4:12" } : card
  )
};

async function seed(page: Page): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await registerMockSportsRoutes(page, OVERVIEW);
}

// The live card (Vikings) sits beside the Lakers' next-game card in the same fixture — this
// compares their footer heights directly instead of trusting a fixed pixel number.
async function expectFootersMatchHeight(page: Page, scope: string): Promise<void> {
  const liveFooter = page.locator(`${scope} .sp-tk__next--live`).first();
  const nextFooter = page.locator(`${scope} .sp-tk__next:not(.sp-tk__next--live)`).first();
  await expect(liveFooter).toBeVisible();
  await expect(nextFooter).toBeVisible();
  const liveBox = (await liveFooter.boundingBox())!;
  const nextBox = (await nextFooter.boundingBox())!;
  expect(Math.abs(liveBox.height - nextBox.height)).toBeLessThanOrEqual(1);
}

test("#2753: Sports page shows the live status line, same footer height as the next-game card", async ({
  page
}) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/sports");

  const liveFooter = page.locator(".sp-ticker .sp-tk__next--live").first();
  await expect(liveFooter).toContainText("Q3 4:12");
  await expectFootersMatchHeight(page, ".sp-ticker");

  await page.locator(".sp-ticker").first().screenshot({ path: "tests/screenshots/2753-sports-desktop.png" });
});

test("#2753: Sports page keeps the live status line at phone width", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/sports");

  const liveFooter = page.locator(".sp-ticker .sp-tk__next--live").first();
  await expect(liveFooter).toContainText("Q3 4:12");

  await page.locator(".sp-ticker").first().screenshot({ path: "tests/screenshots/2753-sports-phone.png" });
});

test("#2753: Today sports desk shows the live status line, same footer height as the next-game card", async ({
  page
}) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");

  const liveFooter = page.locator(".sp-tkgrid .sp-tk__next--live").first();
  await expect(liveFooter).toContainText("Q3 4:12");
  await expectFootersMatchHeight(page, ".sp-tkgrid");

  await page.locator(".sp-tkgrid, .sp-ticker").first().screenshot({
    path: "tests/screenshots/2753-today-desktop.png"
  });
});

test("#2753: Today sports desk keeps the live status line at phone width", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/today");

  const liveFooter = page.locator(".sp-tkgrid .sp-tk__next--live").first();
  await expect(liveFooter).toContainText("Q3 4:12");

  await page.locator(".sp-tkgrid, .sp-ticker").first().screenshot({
    path: "tests/screenshots/2753-today-phone.png"
  });
});
