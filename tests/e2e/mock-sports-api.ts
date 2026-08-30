import type { Page, Route } from "@playwright/test";
import type {
  FollowedTeamCard,
  GameSummary,
  Headline,
  SportsOverviewResponse,
  StandingsGroup
} from "@moss/shared";

// Fixture + route registration for the broadsheet redesign screenshot sweep (#829 Task 5).
// Deliberately NOT wired into the shared MockApiState/mockApi() contract used by every other
// e2e spec — this is a narrow, additive helper for the on-demand capture-screens harness only.

const COMPETITION_LABELS: Record<string, string> = {
  nfl: "NFL",
  nba: "NBA",
  "eng.1": "Premier League",
  mlb: "MLB"
};

function liveGame(): GameSummary {
  return {
    id: "g-live",
    competitionKey: "nfl",
    startsAt: "2026-07-06T23:20:00Z",
    state: "live",
    statusDetail: "Q3 4:12",
    home: {
      teamKey: "min",
      name: "Minnesota Vikings",
      shortName: "MIN",
      crestUrl: null,
      score: 21,
      record: "10-2",
      winner: true
    },
    away: {
      teamKey: "dal",
      name: "Dallas Cowboys",
      shortName: "DAL",
      crestUrl: null,
      score: 14,
      record: "8-4",
      winner: false
    }
  };
}

function finalGame(): GameSummary {
  return {
    id: "g-final",
    competitionKey: "mlb",
    startsAt: "2026-07-06T17:05:00Z",
    state: "final",
    statusDetail: "FT",
    home: {
      teamKey: "nyy",
      name: "New York Yankees",
      shortName: "NYY",
      crestUrl: null,
      score: 6,
      record: "58-40",
      winner: true
    },
    away: {
      teamKey: "bos",
      name: "Boston Red Sox",
      shortName: "BOS",
      crestUrl: null,
      score: 3,
      record: "50-48",
      winner: false
    }
  };
}

function headline(id: string, competitionKey: string, title: string): Headline {
  return {
    id,
    sportKey:
      competitionKey === "nfl"
        ? "football"
        : competitionKey === "nba"
          ? "basketball"
          : competitionKey === "mlb"
            ? "baseball"
            : "soccer",
    competitionKey,
    competitionLabel: COMPETITION_LABELS[competitionKey] ?? competitionKey,
    title,
    url: `https://example.test/${id}`,
    publishedAt: "2026-07-06T18:00:00Z",
    imageUrl: null,
    summary: "",
    teamKeys: [],
    publisherLabel: "ESPN",
    publisherDomain: "espn.com"
  };
}

function followedCard(overrides: Partial<FollowedTeamCard>): FollowedTeamCard {
  return {
    teamKey: "min",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    name: "Minnesota Vikings",
    crestUrl: null,
    status: "live",
    primary: "MIN 21 – 14 DAL",
    stories: [],
    form: ["W", "W", "L"],
    standing: "1st · NFC North",
    nextMatch: null,
    lastMatchAt: null,
    rationale: "Playing right now",
    ...overrides
  };
}

function standingsGroup(): StandingsGroup {
  return {
    competitionKey: "eng.1",
    competitionLabel: "Premier League",
    standingsShape: "record",
    sections: [
      {
        label: null,
        rows: [
          {
            teamKey: "ars",
            name: "Arsenal",
            rank: 1,
            points: 40,
            wins: 12,
            losses: 2,
            draws: 4,
            winPercent: null,
            qualifies: true,
            qualificationNote: null,
            qualificationColor: null
          },
          {
            teamKey: "liv",
            name: "Liverpool",
            rank: 2,
            points: 38,
            wins: 11,
            losses: 3,
            draws: 5,
            winPercent: null,
            qualifies: true,
            qualificationNote: null,
            qualificationColor: null
          }
        ]
      }
    ]
  };
}

// Six followed teams across three leagues (plus a whole-league follow block) — enough ticker
// content at 1440px to overflow and exercise the right-edge fade + internal scroll (spec §2.1).
export const sportsOverviewFixture: SportsOverviewResponse = {
  hero: {
    mode: "gameday",
    games: [
      {
        game: liveGame(),
        competitionLabel: "NFL",
        rationale: "You follow the Vikings — they are on now"
      }
    ]
  },
  followed: [
    followedCard({
      teamKey: "min",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      name: "Minnesota Vikings",
      status: "live",
      primary: "MIN 21 – 14 DAL",
      form: ["W", "W", "L"]
    }),
    followedCard({
      teamKey: "dal",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      name: "Dallas Cowboys",
      status: "live",
      primary: "DAL 14 – 21 MIN",
      form: ["L", "W", "W"]
    }),
    followedCard({
      teamKey: "lal",
      competitionKey: "nba",
      competitionLabel: "NBA",
      name: "Los Angeles Lakers",
      status: "today",
      primary: "",
      form: ["W", "L", "W"],
      standing: "3rd · Pacific",
      nextMatch: {
        opponentName: "Golden State Warriors",
        homeAway: "home",
        startsAt: "2026-07-07T02:00:00.000Z"
      },
      rationale: "Tips off tonight"
    }),
    followedCard({
      teamKey: "bos",
      competitionKey: "nba",
      competitionLabel: "NBA",
      name: "Boston Celtics",
      status: "news",
      primary: "",
      form: ["W", "W", "W"],
      standing: "1st · Atlantic",
      stories: [
        {
          title: "Celtics extend win streak to eight",
          url: "https://example.test/celtics-8",
          publishedAt: "2026-07-06T18:00:00Z",
          imageUrl: null,
          publisherLabel: "ESPN",
          publisherDomain: "espn.com"
        }
      ],
      rationale: "Latest headline"
    }),
    followedCard({
      teamKey: "ars",
      competitionKey: "eng.1",
      competitionLabel: "Premier League",
      name: "Arsenal",
      status: "today",
      primary: "",
      form: ["W", "D", "W"],
      standing: "1st",
      nextMatch: {
        opponentName: "Chelsea",
        homeAway: "away",
        startsAt: "2026-07-09T15:00:00.000Z"
      },
      rationale: "Next match this week"
    }),
    followedCard({
      teamKey: "nyy",
      competitionKey: "mlb",
      competitionLabel: "MLB",
      name: "New York Yankees",
      status: "today",
      primary: "",
      form: ["W", "W", "L"],
      standing: "1st · AL East",
      nextMatch: {
        opponentName: "Boston Red Sox",
        homeAway: "home",
        startsAt: "2026-07-06T23:05:00.000Z"
      },
      rationale: "Playing later today"
    })
  ],
  scoreboard: [
    { competitionKey: "nfl", competitionLabel: "NFL", games: [liveGame()] },
    {
      competitionKey: "nba",
      competitionLabel: "NBA",
      games: [
        {
          id: "g-nba-1",
          competitionKey: "nba",
          startsAt: "2026-07-07T02:00:00Z",
          state: "pre",
          statusDetail: "7:00 PM",
          home: {
            teamKey: "lal",
            name: "Los Angeles Lakers",
            shortName: "LAL",
            crestUrl: null,
            score: null,
            record: "45-20",
            winner: false
          },
          away: {
            teamKey: "gsw",
            name: "Golden State Warriors",
            shortName: "GSW",
            crestUrl: null,
            score: null,
            record: "40-25",
            winner: false
          }
        }
      ]
    },
    { competitionKey: "mlb", competitionLabel: "MLB", games: [finalGame()] }
  ],
  topStories: [
    headline("h1", "nfl", "Vikings clinch division on late field goal"),
    headline("h2", "nba", "Celtics extend win streak to eight"),
    headline("h3", "eng.1", "Arsenal chase table advantage before derby")
  ],
  leagueNews: [
    {
      kind: "competition",
      sportKey: "football",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      headlines: [headline("h4", "nfl", "Cowboys sign veteran lineman")]
    },
    {
      kind: "competition",
      sportKey: "soccer",
      competitionKey: "eng.1",
      competitionLabel: "Premier League",
      headlines: [headline("h5", "eng.1", "Chelsea injury list grows before derby")]
    }
  ],
  standings: [standingsGroup()],
  followedTeams: [
    { competitionKey: "nfl", teamKey: "min" },
    { competitionKey: "nfl", teamKey: "dal" },
    { competitionKey: "nba", teamKey: "lal" },
    { competitionKey: "nba", teamKey: "bos" },
    { competitionKey: "eng.1", teamKey: "ars" },
    { competitionKey: "mlb", teamKey: "nyy" }
  ],
  followedLeagues: [{ competitionKey: "mlb", competitionLabel: "MLB" }],
  // One active followed-league card (Ben 2026-07-09) so the /today Sports desk exercises the
  // TickerLeague component: a lead story with art + a secondary link, plus a live and a final result.
  followedLeagueCards: [
    {
      competitionKey: "mlb",
      competitionLabel: "MLB",
      kind: "league",
      status: "live",
      logoUrl: "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png",
      stories: [
        {
          title: "Trade deadline shakes up the AL East race",
          url: "https://example.com/mlb/deadline",
          publishedAt: "2026-07-09T12:00:00.000Z",
          imageUrl: "https://example.com/img/mlb-deadline.jpg",
          publisherLabel: "ESPN",
          publisherDomain: "espn.com"
        },
        {
          title: "Rookie call-ups to watch down the stretch",
          url: "https://example.com/mlb/rookies",
          publishedAt: "2026-07-09T09:30:00.000Z",
          imageUrl: null,
          publisherLabel: "ESPN",
          publisherDomain: "espn.com"
        }
      ],
      results: [
        {
          line: "NYY 5 – 3 BOS",
          startsAt: "2026-07-09T17:05:00.000Z",
          state: "live",
          detail: "Top 7th"
        },
        {
          line: "LAD 2 – 1 SF",
          startsAt: "2026-07-08T02:10:00.000Z",
          state: "final",
          detail: "Final"
        }
      ]
    }
  ],
  degraded: false
};

// Partial-provider-outage variant (#765 M1 DegradedBand) — same shape, just the flag flipped, for
// the one capture case that needs to render the degraded notice.
export const sportsOverviewDegradedFixture: SportsOverviewResponse = {
  ...sportsOverviewFixture,
  degraded: true
};

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

// Registers /api/sports/overview and marks the "sports" module active in /api/me/modules — the
// per-actor gate the SPA route checks (app.tsx myModulesEnabled) is independent of /api/modules
// (nav display), so both must be overridden for a direct /sports navigation to render instead of
// redirecting to /tasks. Must be called AFTER mockApi() so these routes take priority (Playwright
// resolves overlapping page.route handlers most-recently-registered-first).
export async function registerMockSportsRoutes(
  page: Page,
  overview: SportsOverviewResponse = sportsOverviewFixture
): Promise<void> {
  await page.route("**/api/sports/overview", (route) => fulfillJson(route, 200, overview));
  await page.route("**/api/me/modules", (route) =>
    fulfillJson(route, 200, {
      modules: [
        {
          id: "sports",
          name: "Sports",
          version: "0.1.0",
          lifecycle: "user-toggleable",
          required: false,
          supportsUserDisable: true,
          instanceDisabled: false,
          userDisabled: false,
          active: true
        }
      ]
    })
  );
}
