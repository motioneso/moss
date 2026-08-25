import { describe, expect, it } from "vitest";

import type { SportsSourceAssignmentTarget } from "@moss/shared";
import {
  hasValidSportsSourceTargets,
  sportsNewsScopeCovers,
  sportsSportOptions
} from "../../packages/sports/src/source/scope.js";

describe("sports news source scopes", () => {
  it("derives the five labeled sport options from the catalog", () => {
    expect(sportsSportOptions()).toEqual([
      { key: "football", label: "Football" },
      { key: "basketball", label: "Basketball" },
      { key: "hockey", label: "Hockey" },
      { key: "baseball", label: "Baseball" },
      { key: "soccer", label: "Soccer" }
    ]);
  });

  it("rejects duplicate and unknown targets", () => {
    expect(
      hasValidSportsSourceTargets([
        { kind: "sport", sportKey: "soccer" },
        { kind: "sport", sportKey: "soccer" }
      ])
    ).toBe(false);
    expect(
      hasValidSportsSourceTargets([
        { kind: "sport", sportKey: "cricket" }
      ] as unknown as SportsSourceAssignmentTarget[])
    ).toBe(false);
  });

  it("matches inclusive sport, competition, and team inheritance", () => {
    const team = {
      kind: "team" as const,
      sportKey: "soccer" as const,
      competitionKey: "eng.1",
      teamKey: "liverpool"
    };
    expect(sportsNewsScopeCovers({ kind: "sport", sportKey: "soccer" }, team)).toBe(true);
    expect(
      sportsNewsScopeCovers(
        { kind: "competition", sportKey: "soccer", competitionKey: "eng.1" },
        team
      )
    ).toBe(true);
    expect(sportsNewsScopeCovers(team, team)).toBe(true);
    expect(
      sportsNewsScopeCovers(
        { kind: "competition", sportKey: "soccer", competitionKey: "usa.1" },
        team
      )
    ).toBe(false);
  });
});
