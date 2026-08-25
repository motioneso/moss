import { describe, expect, it } from "vitest";

import type { GameSummary, SportsFollowDto } from "@moss/shared";

import type {
  SourceHeadline,
  StandingsTable
} from "../../packages/sports/src/source/sports-source.js";
import {
  SportsService,
  type SportsServiceDependencies
} from "../../packages/sports/src/sports-service.js";
import { makeDatasetClient, makeDeps, side, userA } from "./sports-service.test.js";

describe("SportsService.getOverview — followed-team dedupe (#855)", () => {
  const livFollow: SportsFollowDto = {
    id: "f-epl",
    competitionKey: "eng.1",
    teamKey: "liv",
    createdAt: "2026-06-01T00:00:00.000Z"
  };
  const livcFollow: SportsFollowDto = {
    id: "f-ucl",
    competitionKey: "uefa.champions",
    teamKey: "livc",
    createdAt: "2026-06-15T00:00:00.000Z" // newer, but eng.1 is a league → still primary
  };

  const eplStandings: StandingsTable = {
    sections: [
      {
        label: null,
        rows: [
          {
            teamKey: "liv",
            name: "Liverpool",
            rank: 2,
            points: 58,
            wins: 18,
            losses: 3,
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
  const uclStandings: StandingsTable = {
    sections: [
      {
        label: "Group A",
        rows: [
          {
            teamKey: "livc",
            name: "Liverpool",
            rank: 1,
            points: 12,
            wins: 4,
            losses: 0,
            draws: 0,
            winPercent: null,
            qualifies: true,
            qualificationNote: null,
            qualificationColor: null
          }
        ]
      }
    ]
  };

  const eplNextMatch: GameSummary = {
    id: "epl-next",
    competitionKey: "eng.1",
    startsAt: "2026-07-10T19:00:00.000Z",
    state: "pre",
    statusDetail: "Fri 3:00 PM",
    home: side({ teamKey: "liv", shortName: "LIV", name: "Liverpool" }),
    away: side({ teamKey: "eve", shortName: "EVE", name: "Everton" })
  };
  const uclNextMatch: GameSummary = {
    id: "ucl-next",
    competitionKey: "uefa.champions",
    startsAt: "2026-07-05T19:00:00.000Z", // soonest across the merged group
    state: "pre",
    statusDetail: "Sun 3:00 PM",
    home: side({ teamKey: "livc", shortName: "LIV", name: "Liverpool" }),
    away: side({ teamKey: "bar", shortName: "BAR", name: "Barcelona" })
  };

  const eplHeadline: SourceHeadline = {
    id: "h-epl",
    competitionKey: "eng.1",
    competitionLabel: "Premier League",
    title: "Liverpool close in on the title",
    url: "https://example.com/liv-epl",
    publishedAt: "2026-06-30T10:00:00.000Z",
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "espn",
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    sourceTeamIds: ["364"]
  };
  const uclHeadlineDuplicateUrl: SourceHeadline = {
    id: "h-ucl-dup",
    competitionKey: "uefa.champions",
    competitionLabel: "Champions League",
    title: "Liverpool close in on the title", // same story, same url, different feed/id
    url: "https://example.com/liv-epl",
    publishedAt: "2026-06-29T10:00:00.000Z",
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "espn",
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    sourceTeamIds: ["364"]
  };
  const uclHeadlineUnique: SourceHeadline = {
    id: "h-ucl-unique",
    competitionKey: "uefa.champions",
    competitionLabel: "Champions League",
    title: "Liverpool through to the quarter-finals",
    url: "https://example.com/liv-ucl",
    publishedAt: "2026-07-01T09:00:00.000Z",
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "espn",
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    sourceTeamIds: ["364"]
  };

  function makeMergedDeps(
    overrides: { follows?: SportsFollowDto[] } = {}
  ): SportsServiceDependencies {
    let scheduleCalls = 0;
    let teamHeadlineCalls = 0;
    const deps = makeDeps({
      follows: overrides.follows ?? [livFollow, livcFollow],
      source: makeDatasetClient({
        listTeams: async (competitionKey) => [
          {
            teamKey: competitionKey === "eng.1" ? "liv" : "livc",
            competitionKey,
            name: "Liverpool",
            shortName: "LIV",
            crestUrl: "https://a.espncdn.com/i/teamlogos/soccer/500/liv.png",
            sourceTeamId: "364" // same club, same ESPN soccer id, across both competitions
          }
        ],
        getScoreboard: async () => [], // no game today on either competition → status "news"
        getStandings: async (competitionKey) =>
          competitionKey === "eng.1" ? eplStandings : uclStandings,
        getSchedule: async (teamKey) => {
          scheduleCalls++;
          return teamKey === "liv" ? [eplNextMatch] : [uclNextMatch];
        },
        getHeadlines: async (competitionKey, teamKey) => {
          if (teamKey) {
            teamHeadlineCalls++;
            return competitionKey === "eng.1"
              ? [eplHeadline]
              : [uclHeadlineDuplicateUrl, uclHeadlineUnique];
          }
          return []; // league-wide feed empty for this fixture — only per-team feeds matter here
        }
      })
    });
    return Object.assign(deps, {
      __scheduleCalls: () => scheduleCalls,
      __teamHeadlineCalls: () => teamHeadlineCalls
    });
  }

  it("merges the same club followed across two competitions into one card", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    expect(overview.followed).toHaveLength(1);
  });

  it("uses the primary (league) follow for teamKey/competitionKey/competitionLabel", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    const card = overview.followed[0]!;
    expect(card.teamKey).toBe("liv");
    expect(card.competitionKey).toBe("eng.1");
    expect(card.competitionLabel).toBe("Premier League");
  });

  it("takes standing from the primary (league) competition only", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    expect(overview.followed[0]!.standing).toBe("#2 · 58 pts");
  });

  it("takes nextMatch as the soonest future match across both competitions", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    expect(overview.followed[0]!.nextMatch).toEqual({
      opponentName: "Barcelona",
      homeAway: "home",
      startsAt: "2026-07-05T19:00:00.000Z",
      opponentCrestUrl: null
    });
  });

  it("pools stories from both competitions' per-team feeds, deduped by url", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    const urls = overview.followed[0]!.stories.map((s) => s.url);
    expect(urls).toContain("https://example.com/liv-epl");
    expect(urls).toContain("https://example.com/liv-ucl");
    expect(urls).toHaveLength(2); // the duplicate-url UCL headline did not add a third entry
  });

  it("names both followed competitions in the rationale via an Oxford join", async () => {
    const service = new SportsService(makeMergedDeps());
    const overview = await service.getOverview(userA);
    expect(overview.followed[0]!.rationale).toBe(
      "You follow Liverpool in Premier League and Champions League."
    );
  });

  it("fetches schedule/team-headlines once per followed competition, not per merged card", async () => {
    const deps = makeMergedDeps() as SportsServiceDependencies & {
      __scheduleCalls: () => number;
      __teamHeadlineCalls: () => number;
    };
    const service = new SportsService(deps);
    await service.getOverview(userA);
    expect(deps.__scheduleCalls()).toBe(2);
    expect(deps.__teamHeadlineCalls()).toBe(2);
  });

  it("does not merge a follow whose sourceTeamId is unresolved, even if it would collide", async () => {
    const unresolved: SportsFollowDto = {
      id: "f-unresolved",
      competitionKey: "usa.1",
      teamKey: "liv2",
      createdAt: "2026-06-20T00:00:00.000Z"
    };
    const service = new SportsService(
      makeDeps({
        follows: [livFollow, unresolved],
        source: makeDatasetClient({
          listTeams: async (competitionKey) =>
            competitionKey === "eng.1"
              ? [
                  {
                    teamKey: "liv",
                    competitionKey,
                    name: "Liverpool",
                    shortName: "LIV",
                    crestUrl: null,
                    sourceTeamId: "364"
                  }
                ]
              : [], // usa.1 team lookup misses → sourceTeamId resolves to null for f-unresolved
          getScoreboard: async () => [],
          getStandings: async () => ({ sections: [] }),
          getSchedule: async () => [],
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.followed).toHaveLength(2);
  });
});
