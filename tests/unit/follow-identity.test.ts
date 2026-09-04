import { describe, expect, it } from "vitest";

import { matchKeyFor, resolveFollowIdentity } from "../../packages/sports/src/follow-identity.js";
import type { SourceTeamRef } from "../../packages/sports/src/source/sports-source.js";

// Review finding S1 (2026-09-04): a saved follow only stores one string. Once two teams can share
// a short name, that string can mean the still-unique short name, a permanent number saved while
// it was shared, or a short name that has since started being shared. These tests prove the
// resolver picks the right team in every case and refuses to guess when it truly cannot tell,
// which the pre-fix code (a plain lookup by the saved string against the current team list) gets
// wrong in three of the four scenarios below.

function team(overrides: Partial<SourceTeamRef> & { teamKey: string }): SourceTeamRef {
  return {
    competitionKey: "ncaa-baseball",
    name: "Team",
    shortName: overrides.teamKey.toUpperCase(),
    crestUrl: null,
    sourceTeamId: null,
    abbreviation: overrides.teamKey,
    ...overrides
  };
}

describe("resolveFollowIdentity", () => {
  it("resolves a still-unique short name directly", () => {
    const teams = [team({ teamKey: "dal", sourceTeamId: "6" })];
    const identity = resolveFollowIdentity("dal", teams);
    expect(identity.ambiguous).toBe(false);
    expect(identity.team?.teamKey).toBe("dal");
    expect(identity.sourceTeamId).toBe("6");
  });

  // Blocker 2: Pacific Lutheran was saved as its numeric id (129700) because it was ambiguous
  // with Pacific Tigers at save time. On this fetch Pacific Tigers is gone, so the list gives
  // Pacific Lutheran back its plain short name "pac" as teamKey. A plain lookup by the saved
  // numeric string against teamKey values would find nothing and the follow would stop
  // resolving; the permanent-number check here must find it instead.
  it("resolves a saved permanent number to its team even after the team's short name is no longer shared", () => {
    const teams = [
      team({
        teamKey: "pac",
        sourceTeamId: "129700",
        abbreviation: "pac",
        name: "Pacific Lutheran Lutes"
      })
    ];
    const identity = resolveFollowIdentity("129700", teams);
    expect(identity.ambiguous).toBe(false);
    expect(identity.team?.name).toBe("Pacific Lutheran Lutes");
    expect(identity.catalogKey).toBe("pac");
    expect(identity.sourceTeamId).toBe("129700");
  });

  // Blocker 1: a follow saved as the plain short name "pac", back when only one PAC team
  // existed. A second PAC team has since appeared, so today's list gives both teams a numeric
  // teamKey and neither carries a plain "pac" teamKey any more. The saved follow can no longer
  // tell the two teams apart and must say so rather than silently pick one.
  it("marks a once-unique saved short name as ambiguous once a second team shares it, instead of guessing", () => {
    const teams = [
      team({
        teamKey: "129700",
        sourceTeamId: "129700",
        abbreviation: "pac",
        name: "Pacific Lutheran Lutes"
      }),
      team({ teamKey: "413", sourceTeamId: "413", abbreviation: "pac", name: "Pacific Tigers" })
    ];
    const identity = resolveFollowIdentity("pac", teams);
    expect(identity.ambiguous).toBe(true);
    expect(identity.team).toBeNull();
    expect(identity.sourceTeamId).toBeNull();
    expect(identity.candidates.map((c) => c.name).sort()).toEqual([
      "Pacific Lutheran Lutes",
      "Pacific Tigers"
    ]);
  });

  // Blocker 2's collision note: a synthetic team's own abbreviation, "413", is the same string as
  // Pacific Tigers' permanent number. A saved follow of "413" must mean the team whose short name
  // is literally "413" here (an exact teamKey match), not get pulled toward Pacific Tigers by the
  // permanent-number check, which only runs after an exact teamKey match has already failed.
  it("does not let a team's own short name collide with another team's permanent number", () => {
    const teams = [
      team({ teamKey: "413", sourceTeamId: "9001", abbreviation: "413", name: "Team 413" }),
      team({ teamKey: "129700", sourceTeamId: "413", abbreviation: "pac", name: "Pacific Tigers" })
    ];
    const identity = resolveFollowIdentity("413", teams);
    expect(identity.ambiguous).toBe(false);
    expect(identity.team?.name).toBe("Team 413");
  });

  it("leaves a follow unresolved, not ambiguous, when the team list is empty", () => {
    const identity = resolveFollowIdentity("pac", []);
    expect(identity.ambiguous).toBe(false);
    expect(identity.team).toBeNull();
    expect(identity.catalogKey).toBe("pac");
  });
});

describe("matchKeyFor", () => {
  it("prefers the permanent number so a shared short name on a game or standings row can't attach to the wrong team", () => {
    const teams = [
      team({
        teamKey: "129700",
        sourceTeamId: "129700",
        abbreviation: "pac",
        name: "Pacific Lutheran Lutes"
      })
    ];
    const identity = resolveFollowIdentity("129700", teams);
    expect(matchKeyFor(identity, "129700")).toBe("129700");
  });

  it("falls back to the saved value when nothing resolved, rather than throwing away the follow", () => {
    const identity = resolveFollowIdentity("pac", []);
    expect(matchKeyFor(identity, "pac")).toBe("pac");
  });
});
