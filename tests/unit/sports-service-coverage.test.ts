import { describe, expect, it, vi } from "vitest";

import type { SourceHeadline } from "../../packages/sports/src/source/sports-source.js";
import { SportsService } from "../../packages/sports/src/sports-service.js";
import { makeDeps, makeSource, TODAY, userA } from "./sports-service.test.js";

function espnHeadline(id: string, url: string): SourceHeadline {
  return {
    id,
    sportKey: "soccer",
    competitionKey: "eng.1",
    competitionLabel: "Premier League",
    title: `ESPN ${id}`,
    url,
    publishedAt: `${TODAY}T12:00:00.000Z`,
    imageUrl: null,
    summary: "",
    teamKeys: [],
    origin: "espn",
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    sourceTeamIds: []
  };
}

describe("SportsService ESPN headline coverage", () => {
  it("fails closed in a separate data context when coverage cannot be read", async () => {
    const getHeadlines = vi.fn(async () => []);
    const dependencies = makeDeps({ source: makeSource({ getHeadlines }) });
    let dataContextCalls = 0;
    const service = new SportsService({
      ...dependencies,
      dataContext: {
        async withDataContext(accessContext, work) {
          dataContextCalls += 1;
          return dependencies.dataContext.withDataContext(accessContext, work);
        }
      },
      espnCoverage: {
        get: async () => {
          throw new Error("coverage read failed");
        }
      }
    });

    const overview = await service.getOverview(userA);

    expect(dataContextCalls).toBe(2);
    expect(getHeadlines).not.toHaveBeenCalled();
    expect(overview.scoreboard.length).toBeGreaterThan(0);
    expect(overview.degraded).toBe(true);
  });

  it("disables only headline datasets while scores and standings still load", async () => {
    const getHeadlines = vi.fn(async () => []);
    const service = new SportsService({
      ...makeDeps({ source: makeSource({ getHeadlines }) }),
      espnCoverage: {
        get: async () => ({ enabled: false, usesDefaultCoverage: false, assignments: [] })
      }
    });

    const overview = await service.getOverview(userA);

    expect(getHeadlines).not.toHaveBeenCalled();
    expect(overview.scoreboard.length).toBeGreaterThan(0);
    expect(overview.standings.length).toBeGreaterThan(0);
  });

  it("honors a team-only ESPN scope without reading its league or opponent feeds", async () => {
    const calls: Array<{ competitionKey: string; teamKey?: string }> = [];
    const service = new SportsService({
      ...makeDeps({
        source: makeSource({
          getHeadlines: async (competitionKey, teamKey) => {
            calls.push({ competitionKey, teamKey });
            return [];
          }
        })
      }),
      espnCoverage: {
        get: async () => ({
          enabled: true,
          usesDefaultCoverage: false,
          assignments: [{ kind: "follow", followId: "f1" }]
        })
      }
    });

    await service.getOverview(userA);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.competitionKey === "nfl" && call.teamKey === "dal")).toBe(
      true
    );
  });

  it("mixes sport-wide custom and ESPN stories and deduplicates canonical URLs", async () => {
    const sharedUrl = "https://example.com/shared?edition=1";
    const service = new SportsService({
      ...makeDeps({
        follows: [
          {
            id: "premier-league",
            competitionKey: "eng.1",
            teamKey: null,
            createdAt: "2026-08-25T00:00:00.000Z"
          }
        ],
        source: makeSource({
          getScoreboard: async () => [],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => [
            espnHeadline("shared", `${sharedUrl}#espn`),
            espnHeadline("espn-only", "https://example.com/espn-only")
          ]
        })
      }),
      publicSourceReader: {
        refresh: async () => ({
          degraded: false,
          persistedResults: 2,
          headlines: [
            {
              id: "fotmob-shared",
              sourceId: "fotmob",
              sportKey: "soccer",
              competitionKey: null,
              competitionLabel: "Soccer",
              title: "FotMob shared",
              url: `${sharedUrl}#fotmob`,
              publishedAt: `${TODAY}T13:00:00.000Z`,
              imageUrl: null,
              summary: "",
              teamKeys: [],
              origin: "custom",
              publisherLabel: "FotMob",
              publisherDomain: "fotmob.com"
            },
            {
              id: "fotmob-only",
              sourceId: "fotmob",
              sportKey: "soccer",
              competitionKey: null,
              competitionLabel: "Soccer",
              title: "FotMob only",
              url: "https://example.com/fotmob-only",
              publishedAt: `${TODAY}T11:00:00.000Z`,
              imageUrl: null,
              summary: "",
              teamKeys: [],
              origin: "custom",
              publisherLabel: "FotMob",
              publisherDomain: "fotmob.com"
            }
          ]
        })
      }
    });

    const overview = await service.getOverview(userA);
    const visible = [...overview.topStories, ...overview.leagueNews.flatMap((g) => g.headlines)];

    expect(visible.filter((headline) => headline.url.startsWith(sharedUrl))).toHaveLength(1);
    expect(new Set(visible.map((headline) => headline.publisherLabel))).toEqual(
      new Set(["FotMob", "ESPN"])
    );
    expect(visible.find((headline) => headline.publisherLabel === "FotMob")).toMatchObject({
      sportKey: "soccer",
      competitionKey: null,
      competitionLabel: "Soccer"
    });
  });
});
