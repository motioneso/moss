import { describe, expect, it } from "vitest";

import type { GameSide, GameSummary } from "@moss/shared";

import { findTeamGame, sideFor, standingLine } from "../../packages/sports/src/followed-card.js";
import type { StandingsTable } from "../../packages/sports/src/source/sports-source.js";

// Review finding S1 (2026-09-04): a scoreboard/standings fetch is per competition, so it cannot
// see that two teams share an abbreviation the way the team list can. When that happens, both
// teams' games and standings rows still carry the same, shared teamKey — only their own numeric
// provider id tells them apart. These tests prove that a lookup by the right numeric id gets the
// right team's data, not whichever of the two teams happened to match first.

function side(overrides: Partial<GameSide> & { sourceTeamId: string | null }): GameSide {
  return {
    teamKey: "pac",
    name: overrides.sourceTeamId === "129700" ? "Pacific Lutheran Lutes" : "Pacific Tigers",
    shortName: "PAC",
    crestUrl: null,
    score: null,
    record: null,
    winner: false,
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
    expect(sideFor(game, "129700")).toBe(lutesSide);
    expect(sideFor(game, "413")).toBe(tigersSide);
  });

  it("findTeamGame still finds the game by either team's numeric id", () => {
    expect(findTeamGame([game], "129700")).toBe(game);
    expect(findTeamGame([game], "413")).toBe(game);
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
    expect(standingLine(sections, "129700")).toContain("3");
    expect(standingLine(sections, "413")).toContain("9");
  });
});
