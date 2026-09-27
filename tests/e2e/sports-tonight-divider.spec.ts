import { expect, test, type Page } from "@playwright/test";
import type { GameSummary, SportsOverviewResponse } from "@moss/shared";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import { registerMockSportsRoutes } from "./mock-sports-api.js";

/**
 * #2752 — the Tonight list wraps into rows of three at desktop width. Every game
 * except the very first drew a divider line on its left with left padding, so the
 * first game of the second row sat indented behind a stray line. The first game of
 * every row must line up with the section's left edge with no divider, while games
 * inside a row keep theirs.
 */

const TONIGHT_NOW = "2026-09-10T16:00:00.000Z";
const TONIGHT_DAY = "2026-09-10";

const MATCHUPS: Array<[string, string, string, string]> = [
  ["LAL", "Los Angeles Lakers", "GSW", "Golden State Warriors"],
  ["BOS", "Boston Celtics", "NYK", "New York Knicks"],
  ["CHI", "Chicago Bulls", "MIA", "Miami Heat"],
  ["DAL", "Dallas Mavericks", "PHX", "Phoenix Suns"],
  ["DEN", "Denver Nuggets", "MIN", "Minnesota Timberwolves"],
  ["SEA", "Seattle Storm", "LV", "Las Vegas Aces"]
];

function tonightGame(index: number): GameSummary {
  const [homeShort, homeName, awayShort, awayName] = MATCHUPS[index]!;
  const tipoffHour = 19 + Math.floor(index / 2);
  const tipoffMin = index % 2 === 0 ? "00" : "30";
  return {
    id: `g-tonight-divider-${index}`,
    competitionKey: "nba",
    startsAt: `${TONIGHT_DAY}T${String(tipoffHour).padStart(2, "0")}:${tipoffMin}:00.000Z`,
    state: "pre",
    statusDetail: "7:00 PM",
    home: {
      teamKey: homeShort.toLowerCase(),
      sourceTeamId: null,
      name: homeName,
      shortName: homeShort,
      crestUrl: null,
      score: null,
      record: "40-25",
      winner: false,
      scorers: null
    },
    away: {
      teamKey: awayShort.toLowerCase(),
      sourceTeamId: null,
      name: awayName,
      shortName: awayShort,
      crestUrl: null,
      score: null,
      record: "38-27",
      winner: false,
      scorers: null
    }
  };
}

// Six pre games after the fixed clock on the same UTC day: two wrapped rows of
// three at desktop width.
const OVERVIEW: SportsOverviewResponse = {
  hero: { mode: "story", headline: null },
  followed: [],
  scoreboard: [
    {
      competitionKey: "nba",
      competitionLabel: "NBA",
      games: [0, 1, 2, 3, 4, 5].map((index) => tonightGame(index))
    }
  ],
  topStories: [],
  leagueNews: [],
  standings: [],
  followedTeams: [],
  followedLeagues: [],
  followedLeagueCards: [],
  ambiguousFollows: [],
  degraded: false
};

async function seed(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date(TONIGHT_NOW));
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

interface RowGeometry {
  left: number;
  top: number;
  borderLeftWidth: string;
  paddingLeft: string;
}

async function tonightRows(page: Page): Promise<RowGeometry[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".jds-brief--sports .sp-tonight__row")];
    return rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        left: rect.left,
        top: rect.top,
        borderLeftWidth: style.borderLeftWidth,
        paddingLeft: style.paddingLeft
      };
    });
  });
}

// Where the game's visible content starts: border box plus its left divider and
// padding. This is what the eye lines up, not the border box itself.
function contentLeft(row: RowGeometry): number {
  return row.left + parseFloat(row.borderLeftWidth) + parseFloat(row.paddingLeft);
}

test("#2752: first game of the wrapped Tonight row lines up with row one, no divider", async ({
  page
}) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");

  const list = page.locator(".jds-brief--sports .sp-tonight");
  await expect(list).toBeVisible();
  await expect(list.locator(".sp-tonight__row")).toHaveCount(6);

  const rows = await tonightRows(page);
  // Six games in a three-column grid wrap onto exactly two rows.
  expect(rows[2]!.top).toBeCloseTo(rows[0]!.top, 0);
  expect(rows[3]!.top).toBeGreaterThan(rows[2]!.top + 1);

  // The first game of row two starts at the same left edge as row one ...
  const rowTwoFirst = rows.findIndex((row) => row.top > rows[2]!.top + 1);
  expect(Math.abs(contentLeft(rows[rowTwoFirst]!) - contentLeft(rows[0]!))).toBeLessThanOrEqual(1);
  // ... with no left divider or indent, while games inside a row keep theirs.
  expect(rows[rowTwoFirst]!.borderLeftWidth).toBe("0px");
  expect(rows[rowTwoFirst]!.paddingLeft).toBe("0px");
  expect(rows[0]!.borderLeftWidth).toBe("0px");
  expect(rows[1]!.borderLeftWidth).not.toBe("0px");

  await list.scrollIntoViewIfNeeded();
  await list.screenshot({ path: "tests/screenshots/2752-tonight-desktop.png" });
});

test("#2752: phone single column keeps every Tonight row flush with no dividers", async ({
  page
}) => {
  await seed(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/today");

  const list = page.locator(".jds-brief--sports .sp-tonight");
  await expect(list).toBeVisible();
  await expect(list.locator(".sp-tonight__row")).toHaveCount(6);

  const rows = await tonightRows(page);
  for (const row of rows) {
    expect(Math.abs(row.left - rows[0]!.left)).toBeLessThanOrEqual(1);
    expect(row.borderLeftWidth).toBe("0px");
  }
});
