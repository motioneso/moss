import { describe, expect, it } from "vitest";

import type { DatasetClient, DatasetEnvelope } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import type { GameSide, GameSummary, SportsFollowDto } from "@moss/shared";

import type {
  SourceHeadline,
  SourceTeamRef,
  StandingsTable
} from "../../packages/sports/src/source/sports-source.js";
import {
  SportsService,
  type SportsServiceDependencies
} from "../../packages/sports/src/sports-service.js";

/**
 * A fake `DatasetClient` dispatching by dataset key, mirroring the shape the retired
 * directly-injected `SportsSource` fixture used (`listTeams`/`getScoreboard`/etc). Errors thrown
 * by a handler are caught here (as the real `createDatasetClient` does) and reported as
 * `degraded: true` with the caller-supplied fallback — preserving the service's pre-migration
 * "never throws, degrades instead" contract for these tests.
 */
interface FakeSourceHandlers {
  listTeams?: (competitionKey: string) => Promise<SourceTeamRef[]>;
  getScoreboard?: (competitionKey: string, day: string, endDay?: string) => Promise<GameSummary[]>;
  getSchedule?: (teamKey: string, competitionKey: string) => Promise<GameSummary[]>;
  getStandings?: (competitionKey: string) => Promise<StandingsTable>;
  getHeadlines?: (competitionKey: string, teamKey?: string) => Promise<SourceHeadline[]>;
  getArticleBody?: (articleId: string) => Promise<string>;
}

// The dataset keys the real manifest declares. Kept next to the stub so the stub can reject an
// undeclared key exactly like the production DatasetClient does (see below) — the divergence
// where the stub swallowed unknown keys into the fallback is what let #857 ship a guaranteed
// /sports 500 past a green gate (Fable C1). New service dataset → add it here AND to the manifest.
const DECLARED_DATASET_KEYS = new Set([
  "teams",
  "scoreboard",
  "schedule",
  "standings",
  "headlines",
  "articleBody"
]);

export function makeDatasetClient(handlers: FakeSourceHandlers = {}): DatasetClient {
  return {
    async getDataset<T>(
      datasetKey: string,
      params: Record<string, unknown>,
      options: { fallback: T }
    ): Promise<DatasetEnvelope<T>> {
      // Mirror the production DatasetClient: an undeclared dataset key is a wiring bug and throws
      // OUTSIDE the fallback try, so it propagates instead of masquerading as a degraded fetch.
      // Only genuine fetch failures within a *declared* dataset fall through to the fallback below.
      if (!DECLARED_DATASET_KEYS.has(datasetKey)) {
        throw new Error(`Unknown dataset "${datasetKey}" for external source "espn"`);
      }
      try {
        let data: unknown;
        switch (datasetKey) {
          case "teams":
            data = await (handlers.listTeams ?? (async () => []))(params.competitionKey as string);
            break;
          case "scoreboard":
            data = await (handlers.getScoreboard ?? (async () => []))(
              params.competitionKey as string,
              params.day as string,
              params.endDay as string | undefined
            );
            break;
          case "schedule":
            data = await (handlers.getSchedule ?? (async () => []))(
              params.teamKey as string,
              params.competitionKey as string
            );
            break;
          case "standings":
            data = await (handlers.getStandings ?? (async () => ({ sections: [] })))(
              params.competitionKey as string
            );
            break;
          case "headlines":
            // teamKey travels through so tests can tell the league feed from a followed
            // team's own feed (the service fetches both — live feedback mraxssnf).
            data = await (handlers.getHeadlines ?? (async () => []))(
              params.competitionKey as string,
              params.teamKey as string | undefined
            );
            break;
          case "articleBody":
            // Per-article featured-hero body (#857); defaults to "" so overview tests that don't
            // care about the body still exercise the real fetch/splice path without stubbing it.
            data = await (handlers.getArticleBody ?? (async () => ""))(params.articleId as string);
            break;
          default:
            // Unreachable: the DECLARED_DATASET_KEYS guard above already rejected unknown keys.
            throw new Error(`unhandled dataset "${datasetKey}"`);
        }
        return { data: data as T, degraded: false, fetchedAt: new Date().toISOString() };
      } catch {
        return { data: options.fallback, degraded: true, fetchedAt: new Date().toISOString() };
      }
    }
  };
}

const FIXED_NOW = new Date("2026-07-01T18:00:00.000Z");
export const TODAY = "2026-07-01";

export const userA: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

export function side(
  overrides: Partial<GameSide> & { teamKey: string; shortName: string }
): GameSide {
  return {
    name: overrides.shortName,
    crestUrl: null,
    score: null,
    record: null,
    winner: false,
    ...overrides
  };
}

const dalLiveGame: GameSummary = {
  id: "g1",
  competitionKey: "nfl",
  startsAt: `${TODAY}T20:00:00.000Z`,
  state: "live",
  statusDetail: "Q3 4:12",
  home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 21 }),
  away: side({ teamKey: "min", shortName: "MIN", name: "Minnesota Vikings", score: 14 })
};

// dal recent form: W, L, D (oldest → newest)
const dalSchedule: GameSummary[] = [
  {
    id: "s1",
    competitionKey: "nfl",
    startsAt: "2026-06-01T20:00:00.000Z",
    state: "final",
    statusDetail: "FT",
    home: side({
      teamKey: "dal",
      shortName: "DAL",
      name: "Dallas Cowboys",
      score: 24,
      winner: true
    }),
    away: side({ teamKey: "nyg", shortName: "NYG", name: "New York Giants", score: 10 })
  },
  {
    id: "s2",
    competitionKey: "nfl",
    startsAt: "2026-06-08T20:00:00.000Z",
    state: "final",
    statusDetail: "FT",
    home: side({
      teamKey: "phi",
      shortName: "PHI",
      name: "Philadelphia Eagles",
      score: 30,
      winner: true
    }),
    away: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 17 })
  },
  {
    id: "s3",
    competitionKey: "nfl",
    startsAt: "2026-06-15T20:00:00.000Z",
    state: "final",
    statusDetail: "FT",
    home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 20 }),
    away: side({ teamKey: "was", shortName: "WAS", name: "Washington", score: 20 })
  },
  // an upcoming (non-final) game — used for nextMatch, ignored by form
  {
    id: "s4",
    competitionKey: "nfl",
    startsAt: "2026-07-05T20:00:00.000Z",
    state: "pre",
    statusDetail: "Sat 3:20 PM",
    home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys" }),
    away: side({ teamKey: "gb", shortName: "GB", name: "Green Bay Packers" })
  }
];

const nflStandings: StandingsTable = {
  sections: [
    {
      label: "National Football Conference",
      rows: [
        {
          teamKey: "dal",
          name: "Dallas Cowboys",
          rank: 1,
          points: null,
          wins: 10,
          losses: 2,
          draws: null,
          winPercent: 0.833,
          qualifies: true,
          qualificationNote: null,
          qualificationColor: null
        }
      ]
    }
  ]
};

const nflHeadlines: SourceHeadline[] = [
  {
    id: "h1",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    title: "Cowboys clinch the division",
    url: "https://example.com/h1",
    publishedAt: `${TODAY}T12:00:00.000Z`,
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "espn",
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    sourceTeamIds: ["6"]
  }
];

const dalTeamFollow: SportsFollowDto = {
  id: "f1",
  competitionKey: "nfl",
  teamKey: "dal",
  createdAt: "2026-06-01T00:00:00.000Z"
};

export function makeSource(overrides: FakeSourceHandlers = {}): DatasetClient {
  return makeDatasetClient({
    listTeams: async () => [],
    getScoreboard: async () => [dalLiveGame],
    getSchedule: async () => dalSchedule,
    getStandings: async () => nflStandings,
    getHeadlines: async () => nflHeadlines,
    ...overrides
  });
}

export function makeDeps(
  overrides: {
    source?: DatasetClient;
    follows?: SportsFollowDto[];
  } = {}
): SportsServiceDependencies {
  const follows = overrides.follows ?? [dalTeamFollow];
  return {
    datasetClient: overrides.source ?? makeSource(),
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    },
    repository: {
      list: async () => follows,
      async create() {
        throw new Error("not exercised by this test file — see sports-service-follows.test.ts");
      },
      async remove() {
        throw new Error("not exercised by this test file — see sports-service-follows.test.ts");
      }
    },
    now: () => FIXED_NOW
  };
}

describe("SportsService.getOverview", () => {
  it("returns a gameday hero when a followed team plays today", async () => {
    const service = new SportsService(makeDeps());
    const overview = await service.getOverview(userA);
    expect(overview.hero.mode).toBe("gameday");
    expect(overview.followedTeams.map((f) => f.teamKey)).toContain("dal");
    expect(overview.degraded).toBe(false);
  });

  // #1386: the hero used to keep the first followed game and reduce the rest to an "N more
  // followed games today" string that no surface ever rendered — a second live game was simply
  // invisible. Every game in the window is now its own slide.
  it("puts every followed game inside the window on the hero, live ones first", async () => {
    // phi kicks off in 10 minutes (inside the T−15min window) but is still `pre`; dal is live.
    // dal is also the FIRST follow, so an ordering that just kept follow order would still pass —
    // the assertion is that live-first wins over follow order, hence phi second.
    const phiGame: GameSummary = {
      id: "g2",
      competitionKey: "nfl",
      startsAt: "2026-07-01T18:10:00.000Z",
      state: "pre",
      statusDetail: "2:10 PM ET",
      home: side({ teamKey: "phi", shortName: "PHI", name: "Philadelphia Eagles" }),
      away: side({ teamKey: "was", shortName: "WAS", name: "Washington" })
    };
    const service = new SportsService(
      makeDeps({
        source: makeSource({ getScoreboard: async () => [phiGame, dalLiveGame] }),
        follows: [
          dalTeamFollow,
          {
            id: "f2",
            competitionKey: "nfl",
            teamKey: "phi",
            createdAt: "2026-06-02T00:00:00.000Z"
          }
        ]
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.hero.mode).toBe("gameday");
    if (overview.hero.mode !== "gameday") return;
    expect(overview.hero.games.map((entry) => entry.game.id)).toEqual(["g1", "g2"]);
    // Each slide carries its own human label and reason — never the raw competitionKey (#765 M4).
    expect(overview.hero.games.map((entry) => entry.competitionLabel)).toEqual(["NFL", "NFL"]);
    expect(overview.hero.games[1]?.rationale).toContain("Philadelphia Eagles");
  });

  it("counts a game between two followed teams once, not twice", async () => {
    // dalLiveGame is DAL v MIN. Follow both and it is still one match — the "N more games"
    // count this replaced had exactly this bug, and as slides it would have shown the same
    // score bar twice in a row.
    const service = new SportsService(
      makeDeps({
        follows: [
          dalTeamFollow,
          {
            id: "f2",
            competitionKey: "nfl",
            teamKey: "min",
            createdAt: "2026-06-02T00:00:00.000Z"
          }
        ]
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.hero.mode).toBe("gameday");
    if (overview.hero.mode !== "gameday") return;
    expect(overview.hero.games).toHaveLength(1);
  });

  it("emits followed teams as competition-scoped pairs", async () => {
    const service = new SportsService(makeDeps());
    const overview = await service.getOverview(userA);
    expect(overview.followedTeams).toEqual([{ competitionKey: "nfl", teamKey: "dal" }]);
  });

  it("joins provider team tags so a matching headline routes to the team's card", async () => {
    // The sourceTeamId→teamKey join is what makes a league headline "about" a followed club.
    // Its observable effect since the hero/card dedup (mrb8ahf7): a tagged story is owned by that
    // club's card (teamStories filters on the resolved teamKeys), not the shared top-stories pool.
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          listTeams: async (competitionKey) => [
            {
              teamKey: "dal",
              competitionKey,
              name: "Dallas Cowboys",
              shortName: "Cowboys",
              crestUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png",
              sourceTeamId: "6" // matches nflHeadlines[0].sourceTeamIds → resolves to "dal"
            }
          ]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const dalCard = overview.followed.find((c) => c.teamKey === "dal");
    expect(dalCard?.stories.map((s) => s.url)).toContain("https://example.com/h1");
  });

  it("marks the followed team card live with derived form", async () => {
    const service = new SportsService(makeDeps());
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("live");
    expect(card?.competitionLabel).toBe("NFL");
    // W (beat NYG), L (lost at PHI), D (tied WAS)
    expect(card?.form).toEqual(["W", "L", "D"]);
    // Labelled section → place-within-section form, not the overall "#1 · 10-2" line
    // (live feedback mraxrdxr, mraz6m43)
    expect(card?.standing).toBe("1st · National Football Conference");
    expect(overview.standings[0]?.standingsShape).toBe("record");
    expect(overview.standings[0]?.sections[0]?.label).toBe("National Football Conference");
  });

  // ESPN's MLB/NHL division labels ("National League West", "Pacific Division") crowd the
  // narrow ticker sub-row; the card line compresses them while the standings rail keeps the
  // full label (live feedback mraxrdxr).
  it("compresses long division labels in the card standing", async () => {
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getStandings: async () => ({
            sections: [
              {
                label: "National League West",
                rows: nflStandings.sections[0]!.rows
              }
            ]
          })
        })
      })
    );
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.standing).toBe("1st · NL West");
    // rail keeps the uncompressed label
    expect(overview.standings[0]?.sections[0]?.label).toBe("National League West");
  });

  it("returns a structured next match with the full opponent name", async () => {
    const service = new SportsService(makeDeps());
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.nextMatch).toEqual({
      opponentName: "Green Bay Packers",
      homeAway: "home",
      startsAt: "2026-07-05T20:00:00.000Z",
      // crest travels with the fixture so the ticker footer can show the opponent's
      // logo in place of the name text (live feedback mrawvc48)
      opponentCrestUrl: null
    });
  });

  it("returns a crest-led result match for a finished today game (annotation #2)", async () => {
    // Ben 2026-07-08 /sports #2: the featured score slot should show the opponent crest + "L 3–9"
    // instead of the cheap "L 3–9 vs Blue Jays" text. The crest + result travel together here.
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getScoreboard: async () => [
            {
              id: "gf",
              competitionKey: "nfl",
              startsAt: `${TODAY}T17:00:00.000Z`,
              state: "final",
              statusDetail: "FT",
              home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 3 }),
              away: side({
                teamKey: "tor",
                shortName: "TOR",
                name: "Toronto Blue Jays",
                score: 9,
                winner: true,
                crestUrl: "https://a.espncdn.com/i/teamlogos/mlb/500/tor.png"
              })
            }
          ]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("today");
    expect(card?.todayGameState).toBe("final");
    expect(card?.resultMatch).toEqual({
      opponentName: "Toronto Blue Jays",
      opponentCrestUrl: "https://a.espncdn.com/i/teamlogos/mlb/500/tor.png",
      // result + scores only; NO "vs Toronto" tail — the crest carries the opponent identity
      scoreText: "L 3–9"
    });
  });

  it("leaves resultMatch null for a live game (keeps the two-abbrev scoreLine)", async () => {
    // Only a finished game gets the crest treatment; a live game keeps its "DAL 21 – 14 MIN" line.
    const service = new SportsService(makeDeps());
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("live");
    expect(card?.resultMatch ?? null).toBeNull();
  });

  it("links the newest team-tagged headline on a news-status card", async () => {
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getScoreboard: async () => [],
          listTeams: async (competitionKey) => [
            {
              teamKey: "dal",
              competitionKey,
              name: "Dallas Cowboys",
              shortName: "Cowboys",
              crestUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png",
              sourceTeamId: "6"
            }
          ]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("news");
    // stories are newest-first; the tagged headline leads (mrb0pk1n replaced single `news`)
    expect(card?.stories[0]).toEqual({
      title: "Cowboys clinch the division",
      url: "https://example.com/h1",
      publishedAt: `${TODAY}T12:00:00.000Z`,
      imageUrl: null,
      publisherLabel: "ESPN",
      publisherDomain: "espn.com"
    });
    expect(card?.name).toBe("Dallas Cowboys");
    expect(card?.crestUrl).toContain("dal.png");
  });

  it("shows the authored empty-news state instead of an unrelated story", async () => {
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getScoreboard: async () => [],
          getHeadlines: async () => [{ ...nflHeadlines[0]!, sourceTeamIds: ["17"] }]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("news");
    expect(card?.stories).toEqual([]);
  });

  // The league-wide feed rarely tags stories to a specific club, so followed cards sat on
  // "No recent news" even when ESPN's per-team feed was full (live feedback mraxssnf). The
  // service now pulls each followed team's own feed and merges it in for that card only.
  it("fills card news from the followed team's own feed when the league feed has none", async () => {
    const teamStory: SourceHeadline = {
      id: "t1",
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: "Cowboys sign a new kicker",
      url: "https://example.com/t1",
      publishedAt: `${TODAY}T10:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn" as const,
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: ["6"]
    };
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getScoreboard: async () => [],
          listTeams: async (competitionKey) => [
            {
              teamKey: "dal",
              competitionKey,
              name: "Dallas Cowboys",
              shortName: "Cowboys",
              crestUrl: null,
              sourceTeamId: "6"
            }
          ],
          // league feed carries only an untagged story; the dal feed has the real one
          getHeadlines: async (_competitionKey, teamKey) =>
            teamKey === "dal"
              ? [teamStory]
              : [{ ...nflHeadlines[0]!, sourceTeamIds: [], title: "League-wide roundup" }]
        })
      })
    );
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("news");
    expect(card?.stories[0]?.title).toBe("Cowboys sign a new kicker");
    // the merge is card-local: the team-feed story must not leak into the league news column
    const nflGroup = overview.leagueNews.find((g) => g.competitionKey === "nfl");
    const leagueTitles = [
      ...overview.topStories.map((h) => h.title),
      ...(nflGroup?.headlines.map((h) => h.title) ?? [])
    ];
    expect(leagueTitles).not.toContain("Cowboys sign a new kicker");
  });

  it("falls back to a story hero on a quiet day", async () => {
    const service = new SportsService(
      makeDeps({ source: makeSource({ getScoreboard: async () => [] }) })
    );
    const overview = await service.getOverview(userA);
    expect(overview.hero.mode).toBe("story");
    if (overview.hero.mode === "story") {
      expect(overview.hero.headline?.title).toBe("Cowboys clinch the division");
    }
  });

  it("degrades (no throw) when the source fails", async () => {
    const badSource = makeSource({
      getScoreboard: async () => {
        throw new Error("ESPN down");
      }
    });
    const service = new SportsService(makeDeps({ source: badSource }));
    const overview = await service.getOverview(userA);
    expect(overview.degraded).toBe(true);
    expect(overview.hero.mode).toBe("story");
  });

  it("ranks by editorial feed position, caps top stories at six, keeps league news distinct", async () => {
    // 9 stories, all tagged to dal ("6"), in ESPN feed order h0..h8 (h0 = editorial lead). Ranking
    // keys off feed POSITION now, not recency (mrb51pnq) — publishedAt only breaks cross-league ties.
    const manyHeadlines: SourceHeadline[] = Array.from({ length: 9 }, (_, i) => ({
      id: `h${i}`,
      competitionKey: "nfl",
      competitionLabel: "NFL",
      title: `Story ${i}`,
      url: `https://example.com/h${i}`,
      publishedAt: `2026-07-01T0${i}:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: ["6"]
    }));
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          getHeadlines: async () => manyHeadlines,
          listTeams: async (competitionKey) => [
            {
              teamKey: "dal",
              competitionKey,
              name: "Dallas Cowboys",
              shortName: "Cowboys",
              crestUrl: null,
              sourceTeamId: "6"
            }
          ]
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories).toHaveLength(6);
    expect(overview.topStories[0]?.id).toBe("h0"); // editorial feed lead first (front of feed)
    const topIds = new Set(overview.topStories.map((h) => h.id));
    expect(overview.leagueNews).toHaveLength(1);
    expect(overview.leagueNews[0]?.competitionLabel).toBe("NFL");
    // Top six [h0..h5] leave the feed tail for the band, in feed order (no byNewest re-sort).
    expect(overview.leagueNews[0]?.headlines.map((h) => h.id)).toEqual(["h6", "h7", "h8"]);
    for (const group of overview.leagueNews) {
      for (const h of group.headlines) expect(topIds.has(h.id)).toBe(false);
    }
  });

  // #763: whole-league follows (teamKey: null) are a first-class picker option but produce no
  // FollowedTeamCard — the overview must surface them separately and let their headlines feed
  // the story hero, so a league-only follower isn't treated as following nothing.
  it("surfaces whole-league follows separately and lets them feed the story hero", async () => {
    const nbaFollow: SportsFollowDto = {
      id: "f2",
      competitionKey: "nba",
      teamKey: null,
      createdAt: "2026-06-01T00:00:00.000Z"
    };
    const nbaHeadline: SourceHeadline = {
      id: "hn1",
      competitionKey: "nba",
      competitionLabel: "NBA",
      title: "NBA free agency shakes up the West",
      url: "https://example.com/hn1",
      publishedAt: `${TODAY}T13:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const service = new SportsService(
      makeDeps({
        follows: [nbaFollow],
        source: makeSource({
          getScoreboard: async () => [],
          getHeadlines: async (competitionKey) => (competitionKey === "nba" ? [nbaHeadline] : [])
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.followed).toEqual([]);
    expect(overview.followedTeams).toEqual([]);
    expect(overview.followedLeagues).toEqual([{ competitionKey: "nba", competitionLabel: "NBA" }]);
    expect(overview.topStories.map((h) => h.id)).toContain("hn1");
    expect(overview.hero.mode).toBe("story");
    if (overview.hero.mode === "story") {
      expect(overview.hero.headline?.title).toBe("NBA free agency shakes up the West");
    }
  });

  it("uses the top-ranked story for the story hero", async () => {
    const service = new SportsService(
      makeDeps({ source: makeSource({ getScoreboard: async () => [] }) })
    );
    const overview = await service.getOverview(userA);
    expect(overview.hero.mode).toBe("story");
    if (overview.hero.mode === "story") {
      expect(overview.hero.headline?.id).toBe(overview.topStories[0]?.id);
    }
  });

  // #764: a brand-new user with zero follows (no teams, no whole-league follows) previously drove
  // `competitionKeys` to `[]`, so the overview fetched nothing and the page rendered as a lone
  // empty-state CTA. It must instead fall back to a small fixed default slate so the frontend's
  // existing populated-empty-state branch (`hasSlate` in sports-page.tsx) has scores/headlines to
  // show alongside the "follow your teams" CTA.
  it("falls back to a default slate of major leagues when the user follows nothing", async () => {
    const requestedComps: string[] = [];
    const nbaGame: GameSummary = {
      id: "nba1",
      competitionKey: "nba",
      startsAt: `${TODAY}T20:00:00.000Z`,
      state: "final",
      statusDetail: "FT",
      home: side({
        teamKey: "bos",
        shortName: "BOS",
        name: "Boston Celtics",
        score: 101,
        winner: true
      }),
      away: side({ teamKey: "mia", shortName: "MIA", name: "Miami Heat", score: 98 })
    };
    const nbaHeadline: SourceHeadline = {
      id: "hd1",
      competitionKey: "nba",
      competitionLabel: "NBA",
      title: "Celtics roll past Heat",
      url: "https://example.com/hd1",
      publishedAt: `${TODAY}T13:00:00.000Z`,
      imageUrl: null,
      summary: "",
      teamKeys: [],
      origin: "espn",
      publisherLabel: "ESPN",
      publisherDomain: "espn.com",
      sourceTeamIds: []
    };
    const service = new SportsService(
      makeDeps({
        follows: [],
        source: makeSource({
          getScoreboard: async (competitionKey) => {
            requestedComps.push(competitionKey);
            return competitionKey === "nba" ? [nbaGame] : [];
          },
          getHeadlines: async (competitionKey) => (competitionKey === "nba" ? [nbaHeadline] : [])
        })
      })
    );
    const overview = await service.getOverview(userA);

    expect(overview.followed).toEqual([]);
    expect(overview.followedTeams).toEqual([]);
    expect(overview.followedLeagues).toEqual([]);
    // the populated-empty-state branch (sports-page.tsx `hasSlate`) needs at least one of these
    expect(
      overview.scoreboard.length + overview.topStories.length + overview.leagueNews.length
    ).toBeGreaterThan(0);
    expect(overview.scoreboard.find((g) => g.competitionKey === "nba")?.games).toEqual([nbaGame]);
    expect(overview.topStories.map((h) => h.id)).toContain("hd1");
    // a small fixed set of major year-round leagues, not the whole catalog (no tournaments)
    expect(new Set(requestedComps)).toEqual(new Set(["nfl", "nba", "nhl", "mlb", "eng.1"]));
  });
});

describe("SportsService.getFollowedFactsForToday", () => {
  it("returns compact non-sensitive strings", async () => {
    const service = new SportsService(makeDeps());
    const { facts } = await service.getFollowedFactsForToday(
      {} as DataContextDb,
      userA.actorUserId
    );
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]?.text).toMatch(/play|won|lost|tied/i);
    expect(facts[0]?.competitionKey).toBe("nfl");
  });

  it("returns no facts (no throw) when the source fails", async () => {
    const badSource = makeSource({
      getScoreboard: async () => {
        throw new Error("ESPN down");
      }
    });
    const service = new SportsService(makeDeps({ source: badSource }));
    const { facts } = await service.getFollowedFactsForToday(
      {} as DataContextDb,
      userA.actorUserId
    );
    expect(facts).toEqual([]);
  });
});

describe("SportsService.today() timezone handling (#761)", () => {
  // 2026-07-05T01:30:00Z is 9:30pm on July 4 in US Eastern (EDT, UTC-4) — the UTC calendar
  // date has already rolled over to July 5, but ESPN's `dates=` param (and tonight's game)
  // is still July 4 in Eastern. A UTC-based `today()` would ask ESPN for the wrong day.
  const LATE_EVENING_ET = new Date("2026-07-05T01:30:00.000Z");
  const ET_DATE = "2026-07-04";
  const UTC_DATE = "2026-07-05";

  it("requests an Eastern yesterday..today window (never the UTC date) from the scoreboard source", async () => {
    // The overview fetches a two-day range ending on the Eastern "today": tonight's games sit
    // under the previous ESPN day once the clock passes Eastern midnight, so a single-day
    // fetch would drop them (see NEAR_GAME_WINDOW_MS in sports-service.ts).
    const seenRanges: { day: string; endDay?: string }[] = [];
    const source = makeSource({
      getScoreboard: async (_competitionKey, day, endDay) => {
        seenRanges.push({ day, endDay });
        return [];
      }
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => LATE_EVENING_ET });
    await service.getOverview(userA);
    expect(seenRanges).toEqual([{ day: "2026-07-03", endDay: ET_DATE }]);
    expect(seenRanges[0]?.endDay).not.toBe(UTC_DATE);
  });

  it("uses the Eastern calendar date for the briefing's followed-facts lookup too", async () => {
    const seenDates: string[] = [];
    const source = makeSource({
      getScoreboard: async (_competitionKey, day) => {
        seenDates.push(day);
        return [dalLiveGame];
      }
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => LATE_EVENING_ET });
    const { facts } = await service.getFollowedFactsForToday(
      {} as DataContextDb,
      userA.actorUserId
    );
    expect(seenDates).toEqual([ET_DATE]);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("still ends the window on the same Eastern day at a UTC instant that's also same-day (control)", async () => {
    // 2026-07-01T18:00:00Z (the shared FIXED_NOW) is 2pm ET the same day — no rollover in play.
    const seenRanges: { day: string; endDay?: string }[] = [];
    const source = makeSource({
      getScoreboard: async (_competitionKey, day, endDay) => {
        seenRanges.push({ day, endDay });
        return [];
      }
    });
    const service = new SportsService(makeDeps({ source }));
    await service.getOverview(userA);
    expect(seenRanges).toEqual([{ day: "2026-06-30", endDay: TODAY }]);
  });
});

describe("SportsService two-day scoreboard window (Eastern-midnight flip)", () => {
  // 2026-07-07T04:18:00Z = 12:18am ET July 7 = 9:18pm PT July 6. ESPN's "today" is already
  // July 7 (tomorrow's slate), while tonight's games live under July 6 — the two-day window
  // brings both back, and currentTeamGame must pick tonight's game, not tomorrow's.
  const PAST_ET_MIDNIGHT = new Date("2026-07-07T04:18:00.000Z");

  // Tonight's final: first pitch 7:10pm PT (02:10Z), ~2h before `now` — inside the near window.
  const tonightFinal: GameSummary = {
    ...dalLiveGame,
    id: "tonight",
    startsAt: "2026-07-07T02:10:00.000Z",
    state: "final",
    statusDetail: "Final",
    home: { ...dalLiveGame.home, score: 5, winner: true },
    away: { ...dalLiveGame.away, score: 3 }
  };

  // Tomorrow's game: 6:40pm ET July 7, ~18h after `now` — outside the near window.
  const tomorrowPre: GameSummary = {
    ...dalLiveGame,
    id: "tomorrow",
    startsAt: "2026-07-07T22:40:00.000Z",
    state: "pre",
    statusDetail: "Scheduled",
    home: { ...dalLiveGame.home, score: null },
    away: { ...dalLiveGame.away, score: null }
  };

  it("cards show tonight's final, not tomorrow's matchup, past Eastern midnight", async () => {
    const source = makeSource({
      getScoreboard: async () => [tonightFinal, tomorrowPre]
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => PAST_ET_MIDNIGHT });
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("today");
    // Result line, not a matchup line — the score proves it's tonight's game.
    expect(card?.primary).toContain("5");
  });

  it("a team whose only window game is tomorrow falls back to the news card", async () => {
    const source = makeSource({
      getScoreboard: async () => [tomorrowPre]
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => PAST_ET_MIDNIGHT });
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    // Tomorrow's game must not read as "today"; the Next row (schedule dataset) carries it.
    expect(card?.status).toBe("news");
  });

  it("a live game from the previous Eastern day still leads the card", async () => {
    // West-coast night game spanning ET midnight: started 10:10pm ET July 6, live at 12:18am.
    const spanningLive: GameSummary = {
      ...dalLiveGame,
      id: "spanning",
      startsAt: "2026-07-07T02:10:00.000Z",
      state: "live"
    };
    const source = makeSource({
      getScoreboard: async () => [spanningLive, tomorrowPre]
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => PAST_ET_MIDNIGHT });
    const overview = await service.getOverview(userA);
    const card = overview.followed.find((c) => c.teamKey === "dal");
    expect(card?.status).toBe("live");
  });
});

describe("SportsService.getCatalog", () => {
  it("lists the approved competitions — static data, zero ESPN calls (#907)", async () => {
    let listTeamsCalls = 0;
    const service = new SportsService(
      makeDeps({
        source: makeSource({
          listTeams: async (competitionKey) => {
            listTeamsCalls++;
            return [
              {
                teamKey: "dal",
                competitionKey,
                name: "Dallas Cowboys",
                shortName: "DAL",
                crestUrl: null,
                sourceTeamId: "6"
              }
            ];
          }
        })
      })
    );
    const catalog = await service.getCatalog();
    expect(catalog.competitions.map((c) => c.competitionKey)).toContain("nfl");
    const nfl = catalog.competitions.find((c) => c.competitionKey === "nfl");
    expect(nfl?.confederation).toBeDefined();
    expect(nfl).not.toHaveProperty("teams");
    expect(catalog.degraded).toBe(false);
    expect(listTeamsCalls).toBe(0);
  });
});
