import { describe, expect, it } from "vitest";

import {
  canonicalClubKey,
  groupFollowedTeams,
  selectPrimaryFollow,
  type ResolvedFollow
} from "../../packages/sports/src/followed-groups.js";

function follow(
  overrides: Partial<ResolvedFollow> & { id: string; teamKey: string }
): ResolvedFollow {
  return {
    competitionKey: "eng.1",
    sourceTeamId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

describe("canonicalClubKey", () => {
  it("combines the competition's espnSport with the source team id", () => {
    const f = follow({ id: "f1", teamKey: "liv", competitionKey: "eng.1" });
    expect(canonicalClubKey(f, "364")).toBe("soccer:364");
  });

  it("returns null when sourceTeamId is null (unresolvable → never merge)", () => {
    const f = follow({ id: "f1", teamKey: "liv", competitionKey: "eng.1" });
    expect(canonicalClubKey(f, null)).toBeNull();
  });

  it("returns null for a competition key not in the catalog", () => {
    const f = follow({ id: "f1", teamKey: "x", competitionKey: "not-in-catalog" });
    expect(canonicalClubKey(f, "1")).toBeNull();
  });
});

describe("groupFollowedTeams", () => {
  it("merges follows from different competitions sharing the same club", () => {
    const f1 = follow({ id: "f1", teamKey: "liv", competitionKey: "eng.1" });
    const f2 = follow({ id: "f2", teamKey: "livc", competitionKey: "uefa.champions" });
    const groups = groupFollowedTeams([f1, f2], () => "364");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.follows.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("keeps follows with an unresolved sourceTeamId as separate singleton groups", () => {
    const f1 = follow({ id: "f1", teamKey: "a", competitionKey: "eng.1" });
    const f2 = follow({ id: "f2", teamKey: "b", competitionKey: "usa.1" });
    const groups = groupFollowedTeams([f1, f2], () => null);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.follows.length)).toEqual([1, 1]);
  });

  it("does not merge follows from different sports even with the same source team id", () => {
    const f1 = follow({ id: "f1", teamKey: "a", competitionKey: "nfl" }); // espnSport football
    const f2 = follow({ id: "f2", teamKey: "b", competitionKey: "eng.1" }); // espnSport soccer
    const groups = groupFollowedTeams([f1, f2], () => "6");
    expect(groups).toHaveLength(2);
  });
});

describe("selectPrimaryFollow", () => {
  it("prefers a league catalog entry over a tournament, even if the tournament follow is newer", () => {
    const league = follow({
      id: "f1",
      teamKey: "liv",
      competitionKey: "eng.1",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    const tournament = follow({
      id: "f2",
      teamKey: "livc",
      competitionKey: "uefa.champions",
      createdAt: "2026-06-15T00:00:00.000Z"
    });
    expect(selectPrimaryFollow([league, tournament])).toBe(league);
  });

  it("tie-breaks among multiple leagues by the most recently created follow", () => {
    const older = follow({
      id: "f1",
      teamKey: "a",
      competitionKey: "eng.1",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    const newer = follow({
      id: "f2",
      teamKey: "b",
      competitionKey: "usa.1",
      createdAt: "2026-06-15T00:00:00.000Z"
    });
    expect(selectPrimaryFollow([older, newer])).toBe(newer);
  });

  it("tie-breaks among multiple tournaments by the most recently created follow when no league exists", () => {
    const older = follow({
      id: "f1",
      teamKey: "a",
      competitionKey: "uefa.champions",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    const newer = follow({
      id: "f2",
      teamKey: "b",
      competitionKey: "fifa.world",
      createdAt: "2026-06-15T00:00:00.000Z"
    });
    expect(selectPrimaryFollow([older, newer])).toBe(newer);
  });

  it("returns the single follow trivially for a singleton group", () => {
    const only = follow({ id: "f1", teamKey: "a", competitionKey: "eng.1" });
    expect(selectPrimaryFollow([only])).toBe(only);
  });

  it("tie-breaks by ascending id when createdAt ties (order-independent)", () => {
    const a = follow({
      id: "b-id",
      teamKey: "a",
      competitionKey: "eng.1",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    const b = follow({
      id: "a-id",
      teamKey: "b",
      competitionKey: "usa.1",
      createdAt: "2026-06-01T00:00:00.000Z"
    });
    expect(selectPrimaryFollow([a, b])).toBe(b);
    expect(selectPrimaryFollow([b, a])).toBe(b);
  });
});
