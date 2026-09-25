import { describe, expect, it } from "vitest";

import type { GameSummary } from "@moss/shared";

import { createEspnDatasetAdapter } from "../../packages/sports/src/source/espn-source.js";
import { SportsService, isoDaysInclusive } from "../../packages/sports/src/sports-service.js";
import { makeDeps, makeSource, side, userA } from "./sports-service.test.js";

// #2679: ESPN answers `scoreboard?dates=YYYYMMDD-YYYYMMDD` with HTTP 400 "Failed to get events
// endpoint" while single days still work, and the NHL team schedule sends `leaders` as one object.

function game(id: string, startsAt: string): GameSummary {
  return {
    id,
    competitionKey: "nfl",
    startsAt,
    state: "final",
    statusDetail: "Final",
    home: side({ teamKey: "dal", shortName: "DAL", name: "Dallas Cowboys", score: 21 }),
    away: side({ teamKey: "min", shortName: "MIN", name: "Minnesota Vikings", score: 14 })
  };
}

describe("isoDaysInclusive", () => {
  it("lists every calendar day across a month end and a DST change", () => {
    expect(isoDaysInclusive("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02"
    ]);
  });

  it("returns the single day when both ends match", () => {
    expect(isoDaysInclusive("2026-07-01", "2026-07-01")).toEqual(["2026-07-01"]);
  });
});

describe("SportsService scoreboard window, one request per day (#2679)", () => {
  const NOW = new Date("2026-07-01T18:00:00.000Z");

  it("never asks the source for a date range", async () => {
    const seen: Array<{ day: string; endDay?: string }> = [];
    const source = makeSource({
      getScoreboard: async (_key, day, endDay) => {
        seen.push({ day, endDay });
        return [];
      }
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => NOW });
    await service.getOverview(userA);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((call) => call.endDay === undefined)).toBe(true);
  });

  it("merges both days' games and drops a game repeated on both days", async () => {
    const yesterday = game("y1", "2026-06-30T23:00:00.000Z");
    const shared = game("both", "2026-07-01T03:00:00.000Z");
    const today = game("t1", "2026-07-01T23:00:00.000Z");
    const source = makeSource({
      getScoreboard: async (_key, day) =>
        day === "2026-06-30" ? [yesterday, shared] : [shared, today]
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => NOW });
    const overview = await service.getOverview(userA);
    const ids = overview.scoreboard.flatMap((group) => group.games.map((g) => g.id));
    expect(ids.filter((id) => id === "both")).toHaveLength(1);
    expect(overview.degraded).toBe(false);
  });

  it("keeps the day that loaded and reports degraded when another day fails", async () => {
    const liveToday: GameSummary = {
      ...game("t1", "2026-07-01T17:00:00.000Z"),
      state: "live",
      statusDetail: "Q3 4:12"
    };
    const source = makeSource({
      getScoreboard: async (_key, day) => {
        if (day === "2026-06-30") throw new Error("ESPN 400");
        return [liveToday];
      }
    });
    const service = new SportsService({ ...makeDeps({ source }), now: () => NOW });
    const overview = await service.getOverview(userA);
    expect(overview.degraded).toBe(true);
    const ids = overview.scoreboard.flatMap((group) => group.games.map((g) => g.id));
    expect(ids).toContain("t1");
  });
});

describe("ESPN adapter on today's payload shapes (#2679)", () => {
  const adapter = createEspnDatasetAdapter();

  it("requests a single scoreboard day", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await adapter.fetchDataset(
      "scoreboard",
      { competitionKey: "nfl", day: "2026-09-21" },
      {
        fetchFn
      }
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/scoreboard\?dates=20260921$/);
  });

  it("reads an NHL team schedule whose leaders arrive as one object", async () => {
    const body = {
      events: [
        {
          id: "401",
          date: "2026-10-08T23:00Z",
          competitions: [
            {
              status: { type: { state: "post", detail: "Final" } },
              competitors: [
                {
                  homeAway: "home",
                  team: { id: "25", abbreviation: "DAL", displayName: "Dallas Stars" },
                  score: { value: 6, displayValue: "6" },
                  leaders: {
                    name: "rating",
                    leaders: [{ displayValue: "5.1", athlete: { shortName: "B. Sennecke" } }]
                  }
                },
                {
                  homeAway: "away",
                  team: { id: "5", abbreviation: "CHI", displayName: "Chicago Blackhawks" },
                  score: null
                }
              ]
            }
          ]
        }
      ]
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const games = (await adapter.fetchDataset(
      "schedule",
      { competitionKey: "nhl", teamKey: "dal", sourceTeamId: "25" },
      { fetchFn }
    )) as GameSummary[];
    expect(games).toHaveLength(1);
    expect(games[0]?.home.score).toBe(6);
    expect(games[0]?.home.scorers).toBeNull();
    expect(games[0]?.away.score).toBeNull();
  });
});
