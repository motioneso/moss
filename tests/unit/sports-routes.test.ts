import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { DatasetClient, DatasetEnvelope } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type {
  CreateSportsFollowRequest,
  GameSide,
  GameSummary,
  SportsFollowDto,
  SportsCustomSourceDto
} from "@moss/shared";
import { SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT } from "@moss/shared";

import {
  registerSportsRoutes,
  type SportsRoutesDependencies
} from "../../packages/sports/src/routes.js";
import { SPORTS_CATALOG } from "../../packages/sports/src/source/catalog.js";
import type {
  SourceHeadline,
  SourceTeamRef,
  StandingsTable
} from "../../packages/sports/src/source/sports-source.js";
import type { SportsSourcesRepository } from "../../packages/sports/src/source/repository.js";
import { makeSourcesRepo } from "./sports-sources-route-fixture.js";

/**
 * A fake `DatasetClient` dispatching by dataset key, mirroring the shape the retired
 * directly-injected `SportsSource` fixture used (`listTeams`/`getScoreboard`/etc), so the
 * per-test overrides below stay close to their pre-migration form. Errors thrown by a handler
 * are caught here (as the real `createDatasetClient` does) and reported as `degraded: true`
 * with the caller-supplied fallback.
 */
interface FakeSourceHandlers {
  listTeams?: (competitionKey: string) => Promise<SourceTeamRef[]>;
  getScoreboard?: (competitionKey: string, day: string) => Promise<GameSummary[]>;
  getSchedule?: (teamKey: string, competitionKey: string) => Promise<GameSummary[]>;
  getStandings?: (competitionKey: string) => Promise<StandingsTable>;
  getHeadlines?: (competitionKey: string) => Promise<SourceHeadline[]>;
}

function makeDatasetClient(
  handlers: FakeSourceHandlers = {},
  // Models Task 1's `cacheOnly` peek (#907 search): a key not in this set behaves as an
  // uncached league (cacheMiss: true, fallback, no live fetch counted); a key present in it
  // falls through to the normal handler below, exactly as the real cache-first client does for
  // a warm entry.
  cachedCompetitionKeys: ReadonlySet<string> = new Set()
): DatasetClient {
  return {
    async getDataset<T>(
      datasetKey: string,
      params: Record<string, unknown>,
      options: { fallback: T; cacheOnly?: boolean }
    ): Promise<DatasetEnvelope<T>> {
      if (options.cacheOnly) {
        const key = params.competitionKey as string;
        if (!cachedCompetitionKeys.has(key)) {
          return {
            data: options.fallback,
            degraded: false,
            cacheMiss: true,
            fetchedAt: new Date().toISOString()
          };
        }
        // fall through: a "cached" league serves via the normal handler below, no live-fetch counted
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
              params.day as string
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
            data = await (handlers.getHeadlines ?? (async () => []))(
              params.competitionKey as string
            );
            break;
          default:
            throw new Error(`unknown dataset "${datasetKey}"`);
        }
        return { data: data as T, degraded: false, fetchedAt: new Date().toISOString() };
      } catch {
        return { data: options.fallback, degraded: true, fetchedAt: new Date().toISOString() };
      }
    }
  };
}

const userA: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

function side(overrides: Partial<GameSide> & { teamKey: string; shortName: string }): GameSide {
  return {
    name: overrides.shortName,
    crestUrl: null,
    score: null,
    record: null,
    winner: false,
    scorers: null,
    ...overrides
  };
}

const dalLiveGame: GameSummary = {
  id: "g1",
  competitionKey: "nfl",
  startsAt: "2026-07-01T20:00:00.000Z",
  state: "live",
  statusDetail: "Q3 4:12",
  home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 21 }),
  away: side({ teamKey: "min", shortName: "MIN", name: "Minnesota Vikings", score: 14 })
};

// An upcoming fixture in the default schedule so the composed overview carries a non-null
// nextMatch — the empty-schedule default let a serialization bug in the nextMatch schema
// (missing opponentCrestUrl row → fast-json-stringify 500) slip past this suite (mrawvc48).
const dalUpcomingGame: GameSummary = {
  id: "g2",
  competitionKey: "nfl",
  startsAt: "2026-07-05T20:00:00.000Z",
  state: "pre",
  statusDetail: "4:00 PM",
  home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys" }),
  away: side({
    teamKey: "gb",
    shortName: "GB",
    name: "Green Bay Packers",
    crestUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png"
  })
};

function makeSource(overrides: FakeSourceHandlers = {}): DatasetClient {
  return makeDatasetClient({
    listTeams: async (competitionKey) => [
      {
        teamKey: "dal",
        competitionKey,
        name: "Dallas Cowboys",
        shortName: "DAL",
        crestUrl: null,
        sourceTeamId: "6"
      }
    ],
    getScoreboard: async () => [dalLiveGame],
    getSchedule: async () => [dalUpcomingGame],
    getStandings: async () => ({ sections: [] }),
    getHeadlines: async () => [],
    ...overrides
  });
}

interface FakeRepo {
  list(scopedDb: DataContextDb): Promise<SportsFollowDto[]>;
  create(scopedDb: DataContextDb, input: CreateSportsFollowRequest): Promise<SportsFollowDto>;
  remove(scopedDb: DataContextDb, id: string): Promise<boolean>;
  created: CreateSportsFollowRequest[];
  removed: string[];
}

function makeRepo(initial: SportsFollowDto[]): FakeRepo {
  const created: CreateSportsFollowRequest[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    list: async () => initial,
    create: async (_db, input) => {
      created.push(input);
      return {
        id: "new-follow",
        competitionKey: input.competitionKey,
        teamKey: input.teamKey ?? null,
        createdAt: "2026-07-01T00:00:00.000Z"
      };
    },
    remove: async (_db, id) => {
      removed.push(id);
      return true;
    }
  };
}

function buildApp(overrides: Partial<SportsRoutesDependencies> & { repo?: FakeRepo } = {}) {
  const repo =
    overrides.repo ??
    makeRepo([
      {
        id: "11111111-1111-1111-1111-111111111111",
        competitionKey: "nfl",
        teamKey: "dal",
        createdAt: "2026-06-01T00:00:00.000Z"
      }
    ]);
  const app = Fastify();
  const deps: SportsRoutesDependencies = {
    datasetClient: overrides.datasetClient ?? makeSource(),
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: overrides.resolveAccessContext ?? (async () => userA),
    repository: repo,
    preferencesRepository: overrides.preferencesRepository,
    now: () => new Date("2026-07-01T18:00:00.000Z"),
    discovery:
      overrides.discovery ??
      ({
        fetch: async () => ({ ok: false, reason: "network" }),
        ai: {
          generateJson: async () => ({ ok: false, error: "needs_config" }),
          fingerprint: async () => null
        }
      } as SportsRoutesDependencies["discovery"]),
    sourcesRepository: overrides.sourcesRepository,
    espnCoverageRepository:
      overrides.espnCoverageRepository ??
      ({
        get: async () => ({ enabled: true, usesDefaultCoverage: true, assignments: [] }),
        replace: async (_db: DataContextDb, assignments: readonly never[]) => ({
          enabled: assignments.length > 0,
          usesDefaultCoverage: false,
          assignments
        })
      } as unknown as NonNullable<SportsRoutesDependencies["espnCoverageRepository"]>),
    storyFeedback:
      overrides.storyFeedback ??
      ({
        refFor: () => "sports:test-ref",
        registerStories: async () => undefined
      } as SportsRoutesDependencies["storyFeedback"]),
    previews: overrides.previews,
    publicSourceReader: overrides.publicSourceReader,
    sourceService: overrides.sourceService
  };
  registerSportsRoutes(app, deps);
  return { app, repo };
}

describe("sports routes", () => {
  it("GET /api/sports/overview returns a composed 200 body", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hero.mode).toBe("gameday");
    expect(
      body.followedTeams.map((f: { competitionKey: string; teamKey: string }) => f.teamKey)
    ).toContain("dal");
    expect(body.degraded).toBe(false);
    // Serialization regression guard: every field the service emits must appear in the
    // response schema — fast-json-stringify REJECTS unknown keys inside the nextMatch oneOf
    // (it doesn't drop them), which 500'd the whole overview when opponentCrestUrl shipped
    // without a schema row (live feedback mrawvc48). Assert the field survives to the wire.
    const withNext = body.followed.find(
      (c: { nextMatch: unknown }) => c.nextMatch !== null && c.nextMatch !== undefined
    );
    expect(withNext).toBeDefined();
    expect(withNext.nextMatch).toHaveProperty("opponentCrestUrl");
    expect(JSON.stringify(body)).not.toContain("sourceTeamIds");
    expect(JSON.stringify(body)).not.toContain("sourceTeamId");
    await app.close();
  });

  it("carries a finished game's resultMatch (crest + score) through to the wire (#885)", async () => {
    // Same class of serialization regression as the nextMatch guard above, but for resultMatch:
    // #867 shipped the crest-leads result card (interface + service + FeaturedTeamCard render)
    // without adding resultMatch to followedTeamCardSchema, so fast-json-stringify silently
    // DROPPED it and every finished-game card degraded to the "L 3–9 vs Blue Jays" text fallback
    // in prod and dev. A final game today (relative to the injected clock) makes the composed dal
    // card carry a non-null resultMatch; assert both the field and its nested crest url survive.
    const { app } = buildApp({
      datasetClient: makeSource({
        // now() = 2026-07-01T18:00Z → a game earlier the same Eastern day reads as today+final.
        getScoreboard: async () => [
          {
            id: "g-final",
            competitionKey: "nfl",
            startsAt: "2026-07-01T16:00:00.000Z",
            state: "final",
            statusDetail: "Final",
            home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 3 }),
            away: side({
              teamKey: "gb",
              shortName: "GB",
              name: "Green Bay Packers",
              score: 9,
              winner: true,
              crestUrl: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png"
            })
          }
        ]
      })
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const dalCard = body.followed.find((c: { teamKey: string }) => c.teamKey === "dal");
    expect(dalCard).toBeDefined();
    // The regression: pre-fix this was undefined (stripped on serialize), not just null.
    expect(dalCard.resultMatch).not.toBeNull();
    expect(dalCard.resultMatch).toBeDefined();
    expect(dalCard.resultMatch.scoreText).toMatch(/^[WL]\s\d+.\d+$/); // "L 3–9" (en-dash)
    expect(dalCard.resultMatch.opponentCrestUrl).toBe(
      "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png"
    );
    // Belt-and-suspenders: the score text is actually present in the raw wire body.
    expect(res.body).toContain(dalCard.resultMatch.scoreText);
    await app.close();
  });

  it("GET /api/sports/catalog returns leagues only — zero ESPN roster calls (#907)", async () => {
    let teamsCalls = 0;
    const { app } = buildApp({
      datasetClient: makeDatasetClient({
        listTeams: async () => {
          teamsCalls++;
          return [];
        }
      })
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/catalog" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.competitions.map((c: { competitionKey: string }) => c.competitionKey)).toContain(
      "nfl"
    );
    expect(body.competitions[0].confederation).toBeDefined();
    expect(body.competitions[0]).toMatchObject({ sportLabel: "Football", regionLabel: null });
    // The wall this spec removes: catalog must not fan out to ESPN per league (#907 §3).
    expect(teamsCalls).toBe(0);
    expect(res.body).not.toContain('"teams"');
    await app.close();
  });

  it("GET /api/sports/follows returns the actor's follows", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/follows" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.follows).toHaveLength(1);
    expect(body.follows[0].competitionKey).toBe("nfl");
    await app.close();
  });

  it("POST /api/sports/follows persists via the repository", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/follows",
      payload: { competitionKey: "nba" }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.follow.competitionKey).toBe("nba");
    expect(repo.created).toEqual([{ competitionKey: "nba", teamKey: null }]);
    await app.close();
  });

  it("POST /api/sports/follows rejects an unknown competitionKey with 400", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/follows",
      payload: { competitionKey: "xyz.made-up" }
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toEqual([]);
    await app.close();
  });

  it("DELETE /api/sports/follows/:id removes and returns ok", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/sports/follows/11111111-1111-1111-1111-111111111111"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(repo.removed).toEqual(["11111111-1111-1111-1111-111111111111"]);
    await app.close();
  });

  it("DELETE /api/sports/follows/:id rejects a non-uuid id with 400", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/api/sports/follows/not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(repo.removed).toEqual([]);
    await app.close();
  });

  it("maps an auth failure to 401", async () => {
    const { app } = buildApp({
      resolveAccessContext: async () => {
        throw new HttpError(401, "Session is missing or expired");
      }
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("carries Headline.summary through the overview response (#840)", async () => {
    const { app } = buildApp({
      datasetClient: makeSource({
        getHeadlines: async () => [
          {
            id: "n1",
            sportKey: "football",
            competitionKey: "nfl",
            competitionLabel: "NFL",
            title: "Vikings clinch division",
            url: "https://example.test/n1",
            publishedAt: "2026-07-01T18:00:00Z",
            imageUrl: null,
            summary: "A late field goal sealed the NFC North.",
            teamKeys: [],
            origin: "espn",
            publisherLabel: "ESPN",
            publisherDomain: "espn.com",
            sourceTeamIds: []
          }
        ]
      })
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("A late field goal sealed the NFC North.");
    await app.close();
  });

  it("carries standings qualification note + color through the overview (#841)", async () => {
    const { app } = buildApp({
      datasetClient: makeDatasetClient({
        getStandings: async () => ({
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
                  qualificationNote: "UEFA Champions League",
                  qualificationColor: "#2a66d1"
                }
              ]
            }
          ]
        })
      }),
      repo: makeRepo([
        {
          id: "f1",
          competitionKey: "eng.1",
          teamKey: null,
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ])
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/overview" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("UEFA Champions League");
    expect(res.body).toContain("#2a66d1");
    await app.close();
  });

  it("GET /api/sports/standings returns one league's group (#842)", async () => {
    const { app } = buildApp({
      datasetClient: makeDatasetClient({
        getStandings: async () => ({
          sections: [
            {
              label: "AFC East",
              rows: [
                {
                  teamKey: "buf",
                  name: "Buffalo Bills",
                  rank: 1,
                  points: null,
                  wins: 11,
                  losses: 3,
                  draws: null,
                  winPercent: 0.786,
                  qualifies: true,
                  qualificationNote: null,
                  qualificationColor: null
                }
              ]
            }
          ]
        })
      })
    });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/sports/standings?competitionKey=nfl"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.group.competitionKey).toBe("nfl");
    expect(body.group.competitionLabel).toBe("NFL");
    expect(body.group.sections[0].label).toBe("AFC East");
    await app.close();
  });

  it("GET /api/sports/standings rejects an unknown competitionKey with 400 (#842)", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/sports/standings?competitionKey=xyz.nope"
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/sports/leagues/:competitionKey/teams returns one league's roster (#907)", async () => {
    const { app } = buildApp({
      datasetClient: makeDatasetClient({
        listTeams: async (competitionKey) => [
          {
            teamKey: "t.ars",
            competitionKey,
            name: "Arsenal",
            shortName: "ARS",
            crestUrl: "https://a.espncdn.com/i/teamlogos/soccer/500/359.png",
            sourceTeamId: "359"
          } as SourceTeamRef
        ]
      })
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/leagues/eng.1/teams" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.teams).toHaveLength(1);
    // Wire-body checks: crestUrl survives serialization; source-internal ids do NOT leak.
    expect(res.body).toContain("crestUrl");
    expect(res.body).not.toContain("sourceTeamId");
    await app.close();
  });

  it("GET /api/sports/leagues/:competitionKey/teams 400s an unknown competition (#907)", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/leagues/nope.9/teams" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/sports/teams/search matches cached rosters across leagues (#907)", async () => {
    let liveFetches = 0;
    const roster = (competitionKey: string): SourceTeamRef[] =>
      competitionKey === "eng.1"
        ? [
            {
              teamKey: "t.ars",
              competitionKey,
              name: "Arsenal",
              shortName: "ARS",
              crestUrl: null
            } as SourceTeamRef
          ]
        : [];
    const cached = new Set(SPORTS_CATALOG.map((c) => c.competitionKey)); // everything warm
    const { app } = buildApp({
      datasetClient: makeDatasetClient(
        {
          listTeams: async (key) => {
            liveFetches++;
            return roster(key);
          }
        },
        cached
      )
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/teams/search?q=arsenal" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.teams.map((t: { teamKey: string }) => t.teamKey)).toEqual(["t.ars"]);
    expect(body.partial).toBe(false);
    // fast-json-stringify strip check: `partial` must be on the wire.
    expect(res.body).toContain('"partial"');
    // Every catalog league is "cached" here, so the fake's cacheOnly fall-through serves each
    // one via the normal handler exactly once (no league skipped for the warm-fill cap) —
    // distinguishes this warm-cache path from the cold-cache cap test below.
    expect(liveFetches).toBe(SPORTS_CATALOG.length);
    await app.close();
  });

  it("search warm-fills at most 5 uncached leagues per query and reports partial (#907)", async () => {
    let liveFetches = 0;
    const { app } = buildApp({
      datasetClient: makeDatasetClient(
        {
          listTeams: async () => {
            liveFetches++;
            return [];
          }
        },
        new Set() // cold cache: all 8 catalog leagues uncached
      )
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/teams/search?q=arsenal" });
    expect(res.statusCode).toBe(200);
    expect(liveFetches).toBe(5); // SEARCH_WARM_FILL_CAP
    expect(JSON.parse(res.body).partial).toBe(true); // 3 of 8 leagues skipped
    await app.close();
  });

  it("search rejects queries shorter than 2 chars via schema (#907)", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/teams/search?q=a" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("search treats a whitespace-only query as too short, not a match-everything wildcard (#907 M)", async () => {
    // Two spaces has raw length 2, so it clears the schema's `minLength: 2` — but trims to "",
    // and `includes("")` matches every team. Without a post-trim length check this would return
    // arbitrary teams from every league AND burn the whole 5-fetch warm-fill budget on a query
    // that's effectively empty.
    let liveFetches = 0;
    const { app } = buildApp({
      datasetClient: makeDatasetClient(
        {
          listTeams: async (key) => {
            liveFetches++;
            return [
              {
                teamKey: `${key}.t1`,
                competitionKey: key,
                name: `Team ${key}`,
                shortName: key.toUpperCase(),
                crestUrl: null
              } as SourceTeamRef
            ];
          }
        },
        new Set() // cold cache: a real bug here would spend the whole warm-fill cap
      )
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/sports/teams/search?q=%20%20" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.teams).toEqual([]);
    expect(body.partial).toBe(false);
    expect(liveFetches).toBe(0);
    await app.close();
  });

  it("POST /api/sports/sources/preview accepts a feed without a JSON model", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<rss><channel><item><title>A consequential sports headline</title><link>https://one.example.com/story</link></item></channel></rss>`,
          truncated: false
        }),
        ai: {
          generateJson: async () => ({ ok: false, error: "needs_config" }),
          fingerprint: async () => null
        }
      }
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources/preview",
      payload: { url: "https://one.example.com" }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "ok",
      candidate: { canonicalDomain: "one.example.com", retrievalMethod: "feed" }
    });
    await app.close();
  });

  it("previews, confirms, and persists a selected target with truthful health", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<rss><channel><item><title>A consequential sports headline</title><link>https://one.example.com/story</link></item></channel></rss>`,
          truncated: false
        }),
        ai: {
          generateJson: async () => ({ ok: false, error: "needs_config" }),
          fingerprint: async () => null
        }
      }
    });
    await app.ready();
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources/preview",
      payload: {
        url: "https://one.example.com",
        assignments: [
          {
            target: {
              kind: "follow",
              followId: "11111111-1111-1111-1111-111111111111"
            }
          }
        ]
      }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = JSON.parse(previewResponse.body);
    expect(preview.candidate.targets).toEqual([
      expect.objectContaining({
        target: {
          kind: "follow",
          followId: "11111111-1111-1111-1111-111111111111"
        },
        label: "Dallas Cowboys",
        scope: "team",
        sampleHeadlines: ["A consequential sports headline"]
      })
    ]);

    const payload = {
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: preview.candidate.canonicalDomain,
      confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
      targets: preview.candidate.targets.map((target: { target: object; targetUrl: string }) => ({
        target: target.target,
        targetUrl: target.targetUrl
      }))
    };
    const confirmResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload
    });
    expect(confirmResponse.statusCode).toBe(201);
    expect(JSON.parse(confirmResponse.body).source).toMatchObject({
      healthState: "healthy",
      assignedFollowIds: ["11111111-1111-1111-1111-111111111111"],
      assignments: [
        {
          followId: "11111111-1111-1111-1111-111111111111",
          previewStatus: "verified",
          healthState: "healthy"
        }
      ]
    });
    expect(sourcesRepository.lockCount).toBe(1);

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload
    });
    expect(replayResponse.statusCode).toBe(409);
    await app.close();
  });

  it("POST /api/sports/sources confirms a preview and returns 400 at the source limit", async () => {
    const sourcesRepository = makeSourcesRepo([], true);
    const previews = {
      put: () => "confirmation-1",
      take: () => ({
        kind: "new-source" as const,
        ownerUserId: userA.actorUserId,
        submittedUrl: "https://publisher.example.com",
        candidate: {
          candidateId: "c1",
          label: "Publisher",
          canonicalDomain: "publisher.example.com",
          homepageUrl: "https://publisher.example.com/",
          feedUrl: "https://publisher.example.com/feed.xml",
          retrievalMethod: "feed" as const,
          sampleCount: 1,
          validationFingerprint: "fp",
          recipe: null,
          recipeFingerprint: null,
          confirmedFetchHosts: ["publisher.example.com"],
          targets: [],
          checkedAt: "2026-08-23T12:00:00.000Z",
          samples: [{ headline: "Headline" }]
        },
        duplicateOfSourceId: null,
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        createdAt: Date.now()
      })
    };
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      previews: previews as unknown as SportsRoutesDependencies["previews"]
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload: {
        confirmationId: "confirmation-1",
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        canonicalDomain: "publisher.example.com",
        confirmedFetchHosts: ["publisher.example.com"],
        targets: []
      }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/sports/sources confirms a preview and assigns follows", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const previews = {
      put: () => "confirmation-1",
      take: () => ({
        kind: "new-source" as const,
        ownerUserId: userA.actorUserId,
        submittedUrl: "https://publisher.example.com",
        candidate: {
          candidateId: "c1",
          label: "Publisher",
          canonicalDomain: "publisher.example.com",
          homepageUrl: "https://publisher.example.com/",
          feedUrl: "https://publisher.example.com/feed.xml",
          retrievalMethod: "feed" as const,
          sampleCount: 1,
          validationFingerprint: "fp",
          recipe: null,
          recipeFingerprint: null,
          confirmedFetchHosts: ["publisher.example.com"],
          checkedAt: "2026-08-23T12:00:00.000Z",
          samples: [{ headline: "Headline" }],
          targets: [
            {
              target: {
                kind: "follow" as const,
                followId: "33333333-3333-3333-3333-333333333333"
              },
              label: "Dallas Cowboys",
              scope: "team" as const,
              targetUrl: "https://publisher.example.com/feed.xml",
              parameters: {},
              samples: [{ headline: "Headline" }],
              checkedAt: "2026-08-23T12:00:00.000Z"
            }
          ]
        },
        duplicateOfSourceId: null,
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        createdAt: Date.now()
      })
    };
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      previews: previews as unknown as SportsRoutesDependencies["previews"]
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload: {
        confirmationId: "confirmation-1",
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        canonicalDomain: "publisher.example.com",
        confirmedFetchHosts: ["publisher.example.com"],
        targets: [
          {
            target: {
              kind: "follow",
              followId: "33333333-3333-3333-3333-333333333333"
            },
            targetUrl: "https://publisher.example.com/feed.xml"
          }
        ]
      }
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.source.assignedFollowIds).toEqual(["33333333-3333-3333-3333-333333333333"]);
    expect(sourcesRepository.assignments).toEqual([]);
    expect(sourcesRepository.lockCount).toBe(1);
    await app.close();
  });

  it("DELETE /api/sports/sources/:id removes a source", async () => {
    const source: SportsCustomSourceDto = {
      id: "11111111-1111-1111-1111-111111111111",
      label: "Publisher",
      canonicalDomain: "publisher.example.com",
      homepageUrl: "https://publisher.example.com/",
      feedUrl: null,
      retrievalMethod: "scrape",
      enabled: true,
      healthState: "pending",
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      recipeStatus: "ready",
      assignedFollowIds: [],
      assignments: [],
      createdAt: "2026-08-21T00:00:00.000Z"
    };
    const sourcesRepository = makeSourcesRepo([source]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository
    });
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/sports/sources/11111111-1111-1111-1111-111111111111"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(sourcesRepository.removed).toEqual(["11111111-1111-1111-1111-111111111111"]);
    await app.close();
  });
});
