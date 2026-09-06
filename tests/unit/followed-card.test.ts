import { describe, expect, it } from "vitest";

import type { GameSide, GameSummary } from "@moss/shared";

import { findTeamGame, sideFor, standingLine } from "../../packages/sports/src/followed-card.js";
import type { StandingsTable } from "../../packages/sports/src/source/sports-source.js";

// Review finding S1 (2026-09-04, round 5): a scoreboard/standings fetch is per competition, so it
// cannot see that two teams share an abbreviation the way the team list can. When that happens,
// both teams' games and standings rows still carry the same, shared teamKey — only the provider's
// permanent team id tells them apart. Since round 5 that id is the ONLY thing these lookups are
// given: the target is a permanent id and nothing else, so there is no short name left to fall
// back to. These tests prove a lookup by the right permanent id gets the right team's data.

function side(overrides: Partial<GameSide> & { sourceTeamId: string | null }): GameSide {
  return {
    teamKey: "pac",
    name: overrides.sourceTeamId === "129700" ? "Pacific Lutheran Lutes" : "Pacific Tigers",
    shortName: "PAC",
    crestUrl: null,
    score: null,
    record: null,
    winner: false,
    scorers: null,
    ...overrides
  };
}

describe("followed-card team matching under a shared abbreviation", () => {
  const lutesSide = side({ sourceTeamId: "129700", score: 4 });
  const tigersSide = side({ sourceTeamId: "413", score: 2 });

  const game: GameSummary = {
    id: "game-1",
    competitionKey: "ncaa-baseball",
    startsAt: "2026-09-04T18:00:00.000Z",
    state: "final",
    statusDetail: "Final",
    home: lutesSide,
    away: tigersSide
  };

  it("sideFor returns the Lutes' own side when asked for the Lutes' numeric id, not the Tigers'", () => {
    expect(sideFor(game, { sourceTeamId: "129700" })).toBe(lutesSide);
    expect(sideFor(game, { sourceTeamId: "413" })).toBe(tigersSide);
  });

  it("findTeamGame still finds the game by either team's numeric id", () => {
    expect(findTeamGame([game], { sourceTeamId: "129700" })).toBe(game);
    expect(findTeamGame([game], { sourceTeamId: "413" })).toBe(game);
  });

  it("standingLine tells the two teams' rows apart by their numeric id", () => {
    const sections: StandingsTable["sections"] = [
      {
        label: null,
        conference: null,
        rows: [
          {
            teamKey: "pac",
            sourceTeamId: "129700",
            name: "Pacific Lutheran Lutes",
            rank: 3,
            points: null,
            wins: 20,
            losses: 5,
            draws: null,
            winPercent: 0.8,
            qualifies: true,
            qualificationNote: null,
            qualificationColor: null
          },
          {
            teamKey: "pac",
            sourceTeamId: "413",
            name: "Pacific Tigers",
            rank: 9,
            points: null,
            wins: 12,
            losses: 13,
            draws: null,
            winPercent: 0.48,
            qualifies: false,
            qualificationNote: null,
            qualificationColor: null
          }
        ]
      }
    ];
    expect(standingLine(sections, { sourceTeamId: "129700" })).toContain("3");
    expect(standingLine(sections, { sourceTeamId: "413" })).toContain("9");
  });
});
