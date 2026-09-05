import { describe, expect, it } from "vitest";

import type { SportsFollowDto } from "@moss/shared";

import type { SourceTeamRef } from "../../packages/sports/src/source/sports-source.js";
import { SportsService } from "../../packages/sports/src/sports-service.js";
import { makeDatasetClient, makeDeps, side, userA } from "./sports-service.test.js";

// Review finding S1, round 5 (2026-09-04). A saved follow now means the provider's permanent team
// number and nothing else. Four earlier rounds tried to work out which team a saved short name
// meant, and each round the reviewer found another way for the guess to attach a score to the
// wrong team. So the guessing is gone: a follow with a number matches by that number everywhere,
// a follow without one matches nothing anywhere, and the person is asked once which team they
// meant. These tests run the whole overview path, so they prove the rule reaches scores, schedule
// and standings, not just the follow list.

function pacTeam(overrides: Partial<SourceTeamRef> & { teamKey: string }): SourceTeamRef {
  return {
    competitionKey: "nfl",
    name: "Team",
    shortName: overrides.teamKey.toUpperCase(),
    crestUrl: null,
    sourceTeamId: null,
    abbreviation: overrides.teamKey,
    ...overrides
  };
}

// Two schools answer to "PAC", so the provider gives each its own permanent number.
const BOTH_PAC_TEAMS = [
  pacTeam({
    teamKey: "pac.129700",
    sourceTeamId: "129700",
    abbreviation: "pac",
    name: "Pacific Lutheran Lutes"
  }),
  pacTeam({
    teamKey: "pac.413",
    sourceTeamId: "413",
    abbreviation: "pac",
    name: "Pacific Tigers"
  })
];

// Saved since round 5: carries Pacific Lutheran's permanent number.
const lutheranFollow: SportsFollowDto = {
  id: "f-pac",
  competitionKey: "nfl",
  teamKey: "pac",
  sourceTeamId: "129700",
  createdAt: "2026-06-01T00:00:00.000Z"
};

// Saved before round 5: a short name and no number at all.
const olderFollow: SportsFollowDto = {
  id: "f-old",
  competitionKey: "nfl",
  teamKey: "pac",
  sourceTeamId: null,
  createdAt: "2026-05-01T00:00:00.000Z"
};

describe("SportsService.getOverview team identity (S1)", () => {
  it("keeps a saved follow's scores attached to the right team once its short name is shared by a second team", async () => {
    // Both schools answer to "PAC" today. The follow carries Pacific Lutheran's number, and the
    // game carries the same number, so the score is the follower's own.
    const lutheranGame = {
      id: "g-lutheran",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "pac",
        shortName: "PAC",
        name: "Pacific Lutheran Lutes",
        score: 4,
        sourceTeamId: "129700"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => BOTH_PAC_TEAMS,
          getScoreboard: async () => [lutheranGame],
          getSchedule: async () => [lutheranGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([]);
    expect(overview.followedTeams).toEqual([
      { competitionKey: "nfl", teamKey: "pac.129700", sourceTeamId: "129700" }
    ]);
    const card = overview.followed.find((c) => c.teamKey === "pac.129700");
    expect(card?.status).toBe("live");
    expect(card?.primary).toContain("4");
  });

  it("hands a follow no score from the other team that shares its short name", async () => {
    // Same short name on both sides of the comparison, different numbers. The number wins, so the
    // Pacific Tigers game never lands on a Pacific Lutheran follower's card.
    const tigersGame = {
      id: "g-tigers",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "pac",
        shortName: "PAC",
        name: "Pacific Tigers",
        score: 7,
        sourceTeamId: "413"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => BOTH_PAC_TEAMS,
          getScoreboard: async () => [tigersGame],
          getSchedule: async () => [tigersGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([]);
    const card = overview.followed.find((c) => c.teamKey === "pac.129700");
    expect(card).toBeDefined();
    expect(card?.status).not.toBe("live");
    expect(JSON.stringify(overview.followed)).not.toContain("Pacific Tigers");
  });

  it("keeps resolving a saved follow after a refresh drops the other team sharing its short name (identity survives a refresh)", async () => {
    // Pacific Tigers is gone from today's list, so the provider hands Pacific Lutheran the plain
    // short name "pac" back. The stored number is unaffected, so the follow resolves exactly as
    // before — the whole point of storing a number that never changes.
    const lutheranGame = {
      id: "g-lutheran-2",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "pac",
        shortName: "PAC",
        name: "Pacific Lutheran Lutes",
        score: 6,
        sourceTeamId: "129700"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 2 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => [
            pacTeam({ teamKey: "pac", sourceTeamId: "129700", name: "Pacific Lutheran Lutes" })
          ],
          getScoreboard: async () => [lutheranGame],
          getSchedule: async () => [lutheranGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([]);
    expect(overview.followedTeams).toEqual([
      { competitionKey: "nfl", teamKey: "pac", sourceTeamId: "129700" }
    ]);
    const card = overview.followed.find((c) => c.teamKey === "pac");
    expect(card).toBeDefined();
    expect(card?.status).toBe("live");
  });

  it("asks which team was meant when the saved follow carries no number, and offers the teams with that short name", async () => {
    // The old save says "pac" and nothing more. Two schools answer to it, so there is nothing to
    // work out and no reason to try: the page asks, and offers both.
    const anyGame = {
      id: "g-any",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "pac",
        shortName: "PAC",
        name: "Pacific Tigers",
        score: 9,
        sourceTeamId: "413"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 3 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [olderFollow],
        source: makeDatasetClient({
          listTeams: async () => BOTH_PAC_TEAMS,
          getScoreboard: async () => [anyGame],
          getSchedule: async () => [anyGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([
      {
        followId: "f-old",
        competitionKey: "nfl",
        savedTeamKey: "pac",
        teamListLoaded: true,
        candidates: [
          { sourceTeamId: "129700", name: "Pacific Lutheran Lutes", crestUrl: null },
          { sourceTeamId: "413", name: "Pacific Tigers", crestUrl: null }
        ]
      }
    ]);
    expect(overview.followedTeams).toEqual([]);
    expect(overview.followed).toEqual([]);
  });

  it("leaves an older cached game with no numbers on it unclaimed", async () => {
    // This game was cached before the permanent number was stored on each side. Claiming it would
    // mean comparing short names again, which is exactly what handed a Pacific Lutheran follower a
    // Pacific Tigers score. So it is left alone and the card simply shows no live score.
    const olderCachedGame = {
      id: "g-old-cache",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({ teamKey: "pac", shortName: "PAC", name: "Pacific Tigers", score: 5 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => BOTH_PAC_TEAMS,
          getScoreboard: async () => [olderCachedGame],
          getSchedule: async () => [olderCachedGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([]);
    const card = overview.followed.find((c) => c.teamKey === "pac.129700");
    expect(card).toBeDefined();
    expect(card?.status).not.toBe("live");
    expect(JSON.stringify(overview.followed)).not.toContain("Pacific Tigers");
  });

  it("claims nothing when the team list did not load and the cached game carries no numbers", async () => {
    // The reviewer's worst case: nothing to check the follow against, and nothing on the game to
    // check it with. A follow that carries a number is still not ambiguous — it just matches
    // nothing today.
    const olderCachedGame = {
      id: "g-old-cache-nolist",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({ teamKey: "pac", shortName: "PAC", name: "Pacific Tigers", score: 5 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => [],
          getScoreboard: async () => [olderCachedGame],
          getSchedule: async () => [olderCachedGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([]);
    const card = overview.followed.find((c) => c.teamKey === "pac");
    expect(card).toBeDefined();
    expect(card?.status).not.toBe("live");
    expect(JSON.stringify(overview.followed)).not.toContain("Pacific Tigers");
  });

  it("withholds a score and says the team list is missing when an older follow cannot be asked about yet", async () => {
    // No team list, so no teams to offer. The page has to say so rather than show an empty choice,
    // and the Tigers score on the board stays off the follower's card.
    const tigersGame = {
      id: "g-tigers-nolist",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "pac",
        shortName: "PAC",
        name: "Pacific Tigers",
        score: 7,
        sourceTeamId: "413"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [olderFollow],
        source: makeDatasetClient({
          listTeams: async () => [],
          getScoreboard: async () => [tigersGame],
          getSchedule: async () => [tigersGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([
      {
        followId: "f-old",
        competitionKey: "nfl",
        savedTeamKey: "pac",
        candidates: [],
        teamListLoaded: false
      }
    ]);
    expect(overview.followed).toEqual([]);
    expect(JSON.stringify(overview.followed)).not.toContain("Pacific Tigers");
  });
});

describe("SportsService.getFollowedFactsForToday team identity (S1)", () => {
  const tigersGame = {
    id: "g-tigers-briefing",
    competitionKey: "nfl",
    startsAt: "2026-07-01T20:00:00.000Z",
    state: "live" as const,
    statusDetail: "Top 7th",
    home: side({
      teamKey: "pac",
      shortName: "PAC",
      name: "Pacific Tigers",
      score: 7,
      sourceTeamId: "413"
    }),
    away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 2 })
  };

  function briefingService(follows: SportsFollowDto[]): SportsService {
    return new SportsService(
      makeDeps({
        follows,
        source: makeDatasetClient({
          listTeams: async () => BOTH_PAC_TEAMS,
          getScoreboard: async () => [tigersGame],
          getSchedule: async () => [tigersGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
  }

  it("says nothing about a saved team that carries no number, instead of the wrong team", async () => {
    const service = briefingService([olderFollow]);
    const { facts } = await service.getFollowedFactsForToday(
      {} as never,
      "00000000-0000-0000-0000-0000000000a1"
    );
    expect(facts).toEqual([]);
  });

  it("says nothing when the only game on the board belongs to the other team with that short name", async () => {
    const service = briefingService([lutheranFollow]);
    const { facts } = await service.getFollowedFactsForToday(
      {} as never,
      "00000000-0000-0000-0000-0000000000a1"
    );
    expect(facts).toEqual([]);
  });

  it("still reports the right team's game when the saved follow carries that team's number", async () => {
    const service = briefingService([{ ...lutheranFollow, sourceTeamId: "413" }]);
    const { facts } = await service.getFollowedFactsForToday(
      {} as never,
      "00000000-0000-0000-0000-0000000000a1"
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain("Pacific Tigers");
  });
});
