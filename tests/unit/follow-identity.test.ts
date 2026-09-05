import { describe, expect, it } from "vitest";

import {
  matchTargetFor,
  resolveFollowIdentity,
  sideMatchesTarget
} from "../../packages/sports/src/follow-identity.js";
import type { SourceTeamRef } from "../../packages/sports/src/source/sports-source.js";

// Review finding S1, round 5 (2026-09-04). Four earlier rounds tried to work out which team a
// saved short name meant, and every round the reviewer found a path where the reading picked the
// wrong team. Since round 5 a saved follow carries the provider's permanent team id, and that id
// is the only thing anything is matched on. These tests pin both halves of the rule:
//   - a follow WITH an id resolves to exactly that team and matches only rows carrying that id;
//   - a follow WITHOUT one (saved before the change) matches nothing at all, in any situation,
//     and instead produces the "which team did you mean?" question.

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

const LUTES = team({
  teamKey: "pac.129700",
  sourceTeamId: "129700",
  abbreviation: "pac",
  name: "Pacific Lutheran Lutes"
});
const TIGERS = team({
  teamKey: "pac.413",
  sourceTeamId: "413",
  abbreviation: "pac",
  name: "Pacific Tigers"
});

describe("resolveFollowIdentity with a permanent team id saved", () => {
  it("finds the team by its permanent id even though two teams share the short name", () => {
    const identity = resolveFollowIdentity(
      { teamKey: "pac", sourceTeamId: "129700" },
      [LUTES, TIGERS]
    );
    expect(identity.needsChoice).toBe(false);
    expect(identity.team?.name).toBe("Pacific Lutheran Lutes");
    expect(identity.catalogKey).toBe("pac.129700");
    expect(identity.sourceTeamId).toBe("129700");
  });

  it("keeps the saved id but offers no key when today's team list has no such team", () => {
    const identity = resolveFollowIdentity({ teamKey: "pac", sourceTeamId: "129700" }, [TIGERS]);
    expect(identity.needsChoice).toBe(false);
    expect(identity.team).toBeNull();
    // No key means nothing can borrow another team's key on this follow's behalf.
    expect(identity.catalogKey).toBeNull();
    expect(identity.sourceTeamId).toBe("129700");
  });

  it("never reads the saved short name, even when it names a different team outright", () => {
    // "413" is Pacific Tigers' permanent id and also the short name of a different club. The
    // saved id wins outright; the short name is not consulted at all.
    const other = team({ teamKey: "413", sourceTeamId: "9001", abbreviation: "413", name: "Team 413" });
    const identity = resolveFollowIdentity({ teamKey: "413", sourceTeamId: "413" }, [other, TIGERS]);
    expect(identity.team?.name).toBe("Pacific Tigers");
    expect(identity.sourceTeamId).toBe("413");
  });
});

describe("resolveFollowIdentity with no permanent team id saved", () => {
  it("asks which team was meant and offers the teams answering to the saved short name", () => {
    const identity = resolveFollowIdentity({ teamKey: "pac", sourceTeamId: null }, [LUTES, TIGERS]);
    expect(identity.needsChoice).toBe(true);
    expect(identity.team).toBeNull();
    expect(identity.sourceTeamId).toBeNull();
    expect(identity.catalogKey).toBeNull();
    expect(identity.teamListLoaded).toBe(true);
    expect(identity.candidates.map((candidate) => candidate.name).sort()).toEqual([
      "Pacific Lutheran Lutes",
      "Pacific Tigers"
    ]);
  });

  it("offers the whole competition when nothing answers to the saved short name", () => {
    const identity = resolveFollowIdentity({ teamKey: "gone", sourceTeamId: null }, [LUTES, TIGERS]);
    expect(identity.needsChoice).toBe(true);
    expect(identity.candidates).toHaveLength(2);
  });

  it("keeps every team reachable when one club is named after another club's number", () => {
    // Review finding S1, round 6 (2026-09-05). "413" is Pacific Tigers' permanent number and also
    // a different club's short name. Offering only the club literally called 413 left a Tigers
    // follower unable to answer the question at all. Everyone is offered; the club whose name
    // matches the saved text simply comes first.
    const named413 = team({
      teamKey: "413",
      sourceTeamId: "9001",
      abbreviation: "413",
      name: "Team 413"
    });
    const identity = resolveFollowIdentity({ teamKey: "413", sourceTeamId: null }, [
      LUTES,
      TIGERS,
      named413
    ]);
    expect(identity.needsChoice).toBe(true);
    expect(identity.candidates.map((candidate) => candidate.name)).toEqual([
      "Team 413",
      "Pacific Lutheran Lutes",
      "Pacific Tigers"
    ]);
  });

  it("reports that no team list loaded, so no choice can be offered yet", () => {
    const identity = resolveFollowIdentity({ teamKey: "pac", sourceTeamId: null }, []);
    expect(identity.needsChoice).toBe(true);
    expect(identity.teamListLoaded).toBe(false);
    expect(identity.candidates).toHaveLength(0);
  });
});

describe("matchTargetFor and sideMatchesTarget", () => {
  it("matches a row by permanent id and refuses the other team wearing the same short name", () => {
    const target = matchTargetFor(
      resolveFollowIdentity({ teamKey: "pac", sourceTeamId: "129700" }, [LUTES, TIGERS])
    );
    expect(target?.sourceTeamId).toBe("129700");
    expect(sideMatchesTarget({ teamKey: "pac", sourceTeamId: "129700" }, target!)).toBe(true);
    expect(sideMatchesTarget({ teamKey: "pac", sourceTeamId: "413" }, target!)).toBe(false);
  });

  // Re-review 4, scenario 1: an older cached game row that carries no permanent id. It used to be
  // claimed on its short name. It can no longer be claimed by anyone, because claiming it means
  // comparing short names, which is what put a Pacific Tigers score on a Pacific Lutheran card.
  it("will not claim an older row that carries no permanent id, even for a followed team", () => {
    const target = matchTargetFor(
      resolveFollowIdentity({ teamKey: "pac", sourceTeamId: "129700" }, [LUTES, TIGERS])
    );
    expect(sideMatchesTarget({ teamKey: "pac" }, target!)).toBe(false);
    expect(sideMatchesTarget({ teamKey: "pac", sourceTeamId: null }, target!)).toBe(false);
  });

  // Re-review 4, scenario 1 again, with the team list down as well: a follow saved before the
  // change plus an old row with no id is the worst case, and it still matches nothing.
  it("gives a follow with no permanent id nothing to match with, list or no list", () => {
    expect(matchTargetFor(resolveFollowIdentity({ teamKey: "pac", sourceTeamId: null }, []))).toBeNull();
    expect(
      matchTargetFor(resolveFollowIdentity({ teamKey: "pac", sourceTeamId: null }, [LUTES, TIGERS]))
    ).toBeNull();
  });
});
