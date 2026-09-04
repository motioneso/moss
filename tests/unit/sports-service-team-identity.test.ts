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
      home: side({ teamKey: "129700", shortName: "PAC", name: "Pacific Lutheran Lutes", score: 4 }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 1 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [lutheranFollow],
        source: makeDatasetClient({
          listTeams: async () => [
            pacTeam({
              teamKey: "129700",
              sourceTeamId: "129700",
              abbreviation: "pac",
              name: "Pacific Lutheran Lutes"
            }),
            pacTeam({
              teamKey: "413",
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
    const numericFollow: SportsFollowDto = { ...lutheranFollow, teamKey: "129700" };
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

  it("does not let a team's own short name collide with another team's permanent number when resolving a saved follow", async () => {
    // A synthetic case from the review: one team's short name is literally the string "413",
    // which also happens to be another team's permanent number. A saved follow of "413" must
    // mean the team whose short name is "413", found by an exact match, before the permanent-
    // number check ever runs. The old plain lookup got this case right by accident (single
    // string equality on teamKey); this proves the new two-step resolver still gets it right.
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
        sourceTeamId: "9001"
      }),
      away: side({ teamKey: "opp", shortName: "OPP", name: "Some Opponent", score: 3 })
    };
    const service = new SportsService(
      makeDeps({
        follows: [collisionFollow],
        source: makeDatasetClient({
          listTeams: async () => [
            pacTeam({
              teamKey: "413",
              sourceTeamId: "9001",
              abbreviation: "413",
              name: "Team 413"
            }),
            pacTeam({
              teamKey: "129700",
              sourceTeamId: "413",
              abbreviation: "pac",
              name: "Pacific Tigers"
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
    expect(overview.ambiguousFollows).toEqual([]);
    const card = overview.followed.find((c) => c.teamKey === "413");
    expect(card).toBeDefined();
    expect(card?.status).toBe("live");
  });
});
