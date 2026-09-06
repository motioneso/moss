import { expect, test, type Page } from "@playwright/test";
import type { FollowedTeamCard, SportsOverviewResponse } from "@moss/shared";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import { registerMockSportsRoutes, sportsOverviewFixture } from "./mock-sports-api.js";

/**
 * #2253 — the finished-game row on the Today sports desk and on the /sports desk.
 *
 * Ben's target, reading left to right for Liverpool 2-0 Ipswich with Isak scoring twice:
 * "Isak 6, 8" · Liverpool crest · "2–0" · Ipswich crest · Ipswich's scorers (none here).
 * The crests and the score stay centred as a group; the scorer columns hang off both
 * outer edges. This spec asserts that order geometrically (left-to-right box positions,
 * not DOM order alone) and writes a picture of each surface to tests/screenshots/ so a
 * reviewer can look at the thing itself.
 */

const LIVERPOOL_CARD: FollowedTeamCard = {
  teamKey: "liv",
  competitionKey: "eng.1",
  competitionLabel: "Premier League",
  name: "Liverpool",
  crestUrl: "https://a.espncdn.com/i/teamlogos/soccer/500/364.png",
  status: "today",
  todayGameState: "final",
  primary: "LIV 2 – 0 IPS",
  stories: [],
  form: ["W", "W", "D"],
  standing: "1st · Premier League",
  nextMatch: null,
  lastMatchAt: "2026-01-04T15:00:00.000Z",
  rationale: "You follow Liverpool",
  resultMatch: {
    opponentName: "Ipswich Town",
    opponentCrestUrl: "https://a.espncdn.com/i/teamlogos/soccer/500/373.png",
    resultLabel: "W",
    homeScore: 2,
    awayScore: 0,
    homeAway: "home",
    ownScorers: ["Isak 6, 8"],
    opponentScorers: null
  }
};

// Hockey gets the same treatment, and both sides carry scorers here so the mirrored
// layout is proved rather than assumed.
const HOCKEY_CARD: FollowedTeamCard = {
  teamKey: "dal",
  competitionKey: "nhl",
  competitionLabel: "NHL",
  name: "Dallas Stars",
  crestUrl: "https://a.espncdn.com/i/teamlogos/nhl/500/dal.png",
  status: "today",
  todayGameState: "final",
  primary: "DAL 4 – 3 COL",
  stories: [],
  form: ["W", "L", "W"],
  standing: "2nd · Central",
  nextMatch: null,
  lastMatchAt: "2026-01-04T01:00:00.000Z",
  rationale: "You follow the Stars",
  resultMatch: {
    opponentName: "Colorado Avalanche",
    opponentCrestUrl: "https://a.espncdn.com/i/teamlogos/nhl/500/col.png",
    resultLabel: "W",
    homeScore: 4,
    awayScore: 3,
    homeAway: "home",
    ownScorers: ["Robertson 12", "Hintz 31", "Seguin 44"],
    opponentScorers: ["MacKinnon 8", "Rantanen 55"]
  }
};

const OVERVIEW: SportsOverviewResponse = {
  ...sportsOverviewFixture,
  hero: { mode: "story", headline: null },
  followed: [LIVERPOOL_CARD, HOCKEY_CARD],
  followedLeagueCards: [],
  scoreboard: [],
  standings: []
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
  // Club badges come from ESPN in real life; a solid square keeps the picture stable and
  // keeps the test off the network.
  await page.route("https://a.espncdn.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#c8102e"/></svg>'
    })
  );
}

// Left-to-right check: home scorers, home badge, score, away badge, away scorers — and the
// badges-plus-score group sitting in the middle of the row.
async function expectBenOrder(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
  const rowBox = (await row.boundingBox())!;
  const homeScorers = (await row.locator("[class$='__scorers--home']").boundingBox())!;
  const awayScorers = (await row.locator("[class$='__scorers--away']").boundingBox())!;
  const badges = await row.locator("span.sp-crest").all();
  expect(badges.length).toBe(2);
  const homeBadge = (await badges[0]!.boundingBox())!;
  const awayBadge = (await badges[1]!.boundingBox())!;
  const score = (await row.locator("[class$='__score']").boundingBox())!;
  expect(homeScorers.x + homeScorers.width).toBeLessThanOrEqual(homeBadge.x + 1);
  expect(homeBadge.x + homeBadge.width).toBeLessThanOrEqual(score.x + 1);
  expect(score.x + score.width).toBeLessThanOrEqual(awayBadge.x + 1);
  expect(awayBadge.x + awayBadge.width).toBeLessThanOrEqual(awayScorers.x + 1);

  // The badges + score sit centred in the row, within a couple of pixels.
  const groupCentre = (homeBadge.x + (awayBadge.x + awayBadge.width)) / 2;
  const rowCentre = rowBox.x + rowBox.width / 2;
  expect(Math.abs(groupCentre - rowCentre)).toBeLessThanOrEqual(3);
}

test("#2253: Today sports desk finished-game row reads scorers, badge, score, badge, scorers", async ({
  page
}) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");

  const row = page.locator(".sp-tk__result").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Isak 6, 8");
  // The score is the bare number pair; the win/loss letter belongs to the form pips now.
  await expect(row.locator(".sp-tk__score")).toHaveText("2–0");
  await expectBenOrder(page, row);

  await page
    .locator(".sp-tkgrid, .sp-ticker")
    .first()
    .screenshot({ path: "tests/screenshots/2253-today-desktop.png" });
});

test("#2253: Today sports desk keeps the same order on a phone width", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/today");

  const row = page.locator(".sp-tk__result").first();
  await expect(row).toBeVisible();
  await expectBenOrder(page, row);

  await page
    .locator(".sp-tkgrid, .sp-ticker")
    .first()
    .screenshot({ path: "tests/screenshots/2253-today-phone.png" });
});

test("#2253: the Sports page ticker shows the same finished-game row", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/sports");

  // The Sports desk draws its own, larger card, so this is a different row from Today's.
  const row = page.locator(".sp-feat__result").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Isak 6, 8");
  await expect(row.locator(".sp-feat__score")).toHaveText("2–0");
  await expectBenOrder(page, row);

  await page
    .locator(".sp-ticker, .sp-feat")
    .first()
    .screenshot({ path: "tests/screenshots/2253-sports-desktop.png" });
});
