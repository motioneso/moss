import { describe, expect, it } from "vitest";

import type { SportsFollowDto } from "@moss/shared";

import type { SourceTeamRef } from "../../packages/sports/src/source/sports-source.js";
import { SportsService } from "../../packages/sports/src/sports-service.js";
import { makeDatasetClient, makeDeps, side, userA } from "./sports-service.test.js";

// Review finding S1 (2026-09-04): before this fix a saved follow was matched against the day's
// team list by plain string equality on `teamKey`. That breaks the moment a short name is shared
// by two teams, because ESPN only gives the collision a stable identity (a numeric id in place of
// the shared short name) for as long as both teams are in the list together. These tests exercise
// the whole `getOverview` path — not just the resolver in isolation — so they also prove the fix
// reaches scores, schedule and standings, not just the follow list.

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

const lutheranFollow: SportsFollowDto = {
  id: "f-pac",
  competitionKey: "nfl",
  teamKey: "pac",
  createdAt: "2026-06-01T00:00:00.000Z"
};

describe("SportsService.getOverview team identity (S1)", () => {
  it("keeps a saved follow's scores attached to the right team once its short name is shared by a second team", async () => {
    // "pac" was unique when the follow was saved. Today's list has a second PAC team, so ESPN
    // gives both teams numeric ids instead of the shared short name. The old code matched the
    // saved string "pac" straight against the game rows below — since neither row's teamKey is
    // "pac" any more, the follow would have shown no score and no standing at all instead of
    // being reported as ambiguous.
    const lutheranGame = {
      id: "g-lutheran",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({ teamKey: "pac", shortName: "PAC", name: "Pacific Lutheran Lutes", score: 4 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => [
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
          ],
          getScoreboard: async () => [lutheranGame],
          getSchedule: async () => [lutheranGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([
      {
        competitionKey: "nfl",
        savedTeamKey: "pac",
        candidateNames: ["Pacific Lutheran Lutes", "Pacific Tigers"]
      }
    ]);
    // The follow is kept out of every card rather than guessed at.
    expect(overview.followed).toHaveLength(0);
    expect(overview.followedTeams).toHaveLength(0);
  });

  it("keeps resolving a saved follow after a refresh drops the other team sharing its short name (identity survives a refresh)", async () => {
    // The follow was saved as the numeric id "129700" while "pac" was shared with Pacific Tigers.
    // On this fetch Pacific Tigers is gone, so the list gives Pacific Lutheran its plain short
    // name "pac" back as teamKey. The old code looked the saved string "129700" up directly
    // against teamKey values on the new list, found nothing, and the follow stopped resolving —
    // no score, no standing, silently dropped from the page.
    const numericFollow: SportsFollowDto = { ...lutheranFollow, teamKey: "pac.129700" };
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
        follows: [numericFollow],
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

  it("asks which team was meant when a saved value is one team's number and another's name", async () => {
    // Straight from the provider's real output for the review's three-team input: Pacific
    // Lutheran and Pacific Tigers share "PAC" and so carry the short name joined to their own
    // numbers, while a fourth team really is named "413" — which is also the Tigers' number.
    // An old save of "413" could be either the Tigers (whose number it is) or the club actually
    // named 413 (re-review 3 blocker 2). It used to resolve silently to Team 413; the page must
    // now withhold both and ask which was meant.
    const collisionFollow: SportsFollowDto = { ...lutheranFollow, teamKey: "413" };
    const game413 = {
      id: "g-413",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({
        teamKey: "413",
        shortName: "413",
        name: "Team 413",
        score: 9,
        sourceTeamId: "7001"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 3 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [collisionFollow],
        source: makeDatasetClient({
          listTeams: async () => [
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
            }),
            pacTeam({
              teamKey: "413",
              sourceTeamId: "7001",
              abbreviation: "413",
              name: "Team 413"
            })
          ],
          getScoreboard: async () => [game413],
          getSchedule: async () => [game413],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.ambiguousFollows).toEqual([
      {
        competitionKey: "nfl",
        savedTeamKey: "413",
        candidateNames: ["Pacific Tigers", "Team 413"]
      }
    ]);
    expect(overview.followedTeams).toEqual([]);
    expect(overview.followed).toEqual([]);
  });

  it("still finds a followed team on an older cached game that carries no provider number", async () => {
    // The team list gives Pacific Lutheran a permanent number, but this game was cached before
    // the number was stored alongside each side. Matching on the number alone would find nothing
    // and the card would show no score at all — the failure the reviewer reproduced.
    const olderCachedGame = {
      id: "g-old-cache",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({ teamKey: "pac", shortName: "PAC", name: "Pacific Lutheran Lutes", score: 5 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => [
            pacTeam({ teamKey: "pac", sourceTeamId: "129700", name: "Pacific Lutheran Lutes" })
          ],
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
    expect(card?.status).toBe("live");
    expect(card?.primary).toContain("5");
  });

  // Re-review 3 blocker 1, first half. The team list did not load at all, so nothing can check
  // what the saved "pac" means. The scoreboard carries a Pacific Tigers game with its own
  // permanent number. Handing that score to a Pacific Lutheran follower is the wrong-team bug;
  // the page must show no score and ask which team was meant.
  it("withholds a score and asks when no team list loaded and the game carries a number", async () => {
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
        follows: [lutheranFollow],
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
      { competitionKey: "nfl", savedTeamKey: "pac", candidateNames: [] }
    ]);
    const card = overview.followed.find((c) => c.teamKey === "pac");
    expect(card?.status).not.toBe("live");
    // No Tigers score anywhere on the follower's own card, and the follow marks nothing "you".
    expect(JSON.stringify(overview.followed)).not.toContain("Pacific Tigers");
  });

  // Re-review 3 blocker 1, second half. The complete three-team list is available and the follow
  // is Pacific Lutheran by number, but an older cached Pacific Tigers game has no numbers on its
  // sides. "PAC" means two schools today, so it may not settle anything: the Tigers game must not
  // be attached to the Pacific Lutheran card.
  it("will not attach a number-less cached game to a follow whose short name two teams share", async () => {
    const cachedTigersGame = {
      id: "g-tigers-nonumbers",
      competitionKey: "nfl",
      startsAt: "2026-07-01T20:00:00.000Z",
      state: "live" as const,
      statusDetail: "Top 7th",
      home: side({ teamKey: "pac", shortName: "PAC", name: "Pacific Tigers", score: 7 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [{ ...lutheranFollow, teamKey: "pac.129700" }],
        source: makeDatasetClient({
          listTeams: async () => [
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
            }),
            pacTeam({ teamKey: "413", sourceTeamId: "9001", abbreviation: "413", name: "Team 413" })
          ],
          getScoreboard: async () => [cachedTigersGame],
          getSchedule: async () => [cachedTigersGame],
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
});

describe("SportsService.getFollowedFactsForToday team identity (S1)", () => {
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
    away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 2 })
  };

  function briefingService(follows: SportsFollowDto[]): SportsService {
    return new SportsService(
      makeDeps({
        follows,
        source: makeDatasetClient({
          listTeams: async () => [
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
          ],
          getScoreboard: async () => [tigersGame],
          getSchedule: async () => [tigersGame],
          getStandings: async () => ({ sections: [] }),
          getHeadlines: async () => []
        })
      })
    );
  }

  it("says nothing about a saved team it can no longer tell apart, instead of the wrong team", async () => {
    // Saved as "pac" when only one school answered to it. Today two do, and the only game on the
    // board is the other school's. The briefing used to read the saved short name straight off
    // the board and announce Pacific Tigers to someone following Pacific Lutheran.
    const service = briefingService([lutheranFollow]);
    const { facts } = await service.getFollowedFactsForToday(
      {} as never,
      "00000000-0000-0000-0000-0000000000a1"
    );
    expect(facts).toEqual([]);
  });

  it("still reports the right team's game when the saved follow can be told apart", async () => {
    const service = briefingService([{ ...lutheranFollow, teamKey: "pac.413" }]);
    const { facts } = await service.getFollowedFactsForToday(
      {} as never,
      "00000000-0000-0000-0000-0000000000a1"
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain("Pacific Tigers");
  });
});
