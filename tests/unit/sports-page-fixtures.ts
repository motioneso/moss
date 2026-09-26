// Shared overview fixtures for the Sports page render tests.

import type {
  FollowedTeamCard,
  GameSummary,
  Headline,
  OverviewHero,
  SportsOverviewResponse,
  StandingsGroup
} from "@moss/shared";

export function liveGame(): GameSummary {
  return {
    id: "g-live",
    competitionKey: "nfl",
    startsAt: "2026-07-01T23:20:00Z",
    state: "live",
    statusDetail: "Q3 4:12",
    home: {
      teamKey: "min",
      sourceTeamId: "16",
      name: "Minnesota Vikings",
      shortName: "MIN",
      crestUrl: null,
      score: 21,
      record: "10-2",
      winner: true,
      scorers: null
    },
    away: {
      teamKey: "dal",
      sourceTeamId: "6",
      name: "Dallas Cowboys",
      shortName: "DAL",
      crestUrl: null,
      score: 14,
      record: "8-4",
      winner: false,
      scorers: null
    }
  };
}

export function followedCard(overrides: Partial<FollowedTeamCard> = {}): FollowedTeamCard {
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
    nextMatch: {
      opponentName: "Green Bay Packers",
      homeAway: "home",
      startsAt: "2026-07-05T20:00:00.000Z"
    },
    lastMatchAt: "2026-06-29T20:00:00.000Z",
    rationale: "Playing right now",
    ...overrides
  };
}

export function standingsGroup(): StandingsGroup {
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
            sourceTeamId: "359",
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
          }
        ]
      }
    ]
  };
}

const TEST_COMPETITION_LABELS: Record<string, string> = {
  nfl: "NFL",
  nba: "NBA",
  epl: "Premier League",
  "eng.1": "Premier League"
};

export function headline(
  id: string,
  competitionKey: string,
  title: string,
  overrides: Partial<Headline> = {}
): Headline {
  return {
    id,
    sportKey: "football",
    competitionKey,
    competitionLabel: TEST_COMPETITION_LABELS[competitionKey] ?? competitionKey.toUpperCase(),
    title,
    url: "https://example.test/" + id,
    publishedAt: "2026-07-01T18:00:00Z",
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    summary: "",
    teamKeys: [],
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    ...overrides
  };
}

// The hero carries every followed game in the window, not just the lead one (#1386), so each
// fixture spells out its slides.
export function gamedayHero(...games: GameSummary[]): Extract<OverviewHero, { mode: "gameday" }> {
  return {
    mode: "gameday",
    games: games.map((game) => ({
      game,
      competitionLabel: TEST_COMPETITION_LABELS[game.competitionKey] ?? "NFL",
      rationale: `You follow ${game.home.name}.`
    }))
  };
}

export function makeOverview(
  overrides: Partial<SportsOverviewResponse> = {}
): SportsOverviewResponse {
  return {
    hero: gamedayHero(liveGame()),
    followed: [followedCard()],
    scoreboard: [
      {
        competitionKey: "nfl",
        competitionLabel: "NFL",
        games: [liveGame()]
      }
    ],
    topStories: [headline("h1", "nfl", "Vikings clinch division on late field goal")],
    leagueNews: [
      {
        kind: "competition",
        sportKey: "football",
        competitionKey: "nfl",
        competitionLabel: "NFL",
        headlines: [headline("h2", "nfl", "Cowboys sign veteran lineman")]
      }
    ],
    standings: [standingsGroup()],
    followedTeams: [{ competitionKey: "nfl", teamKey: "min", sourceTeamId: "16" }],
    followedLeagues: [],
    followedLeagueCards: [],
    ambiguousFollows: [],
    degraded: false,
    ...overrides
  };
}
