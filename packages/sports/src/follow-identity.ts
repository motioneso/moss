import type { SourceTeamRef } from "./source/sports-source.js";

// A saved follow only ever stored one string (`teamKey`), and the team-identity change (review
// finding S1) means that string can mean three different things depending on when it was saved
// and what the live team list looks like today: the team's still-unique short name, its numeric
// id (saved while its short name was shared with another team), or a short name that has SINCE
// started being shared. Reading the saved string straight off the live list, as every call site
// used to, could silently attach the follow to a different physical team the moment a short name
// stopped being unique. This resolves it once per page load against the live list instead, and
// tells the caller when it genuinely cannot be told apart.
export interface ResolvedTeamIdentity {
  /** The team this follow currently means, or null when it can't be told apart from another team. */
  readonly team: SourceTeamRef | null;
  /** The provider's permanent number for that team, when known. Use this (never a short name) to
   *  match games, schedules and standings rows, which always carry the raw, possibly-shared short
   *  name as their own identity and have no way to know it collided. */
  readonly sourceTeamId: string | null;
  /** The team's identity as it appears in today's team list — a short name, or a number if that
   *  short name is shared right now. Use this to match team-tagged news, which is already tagged
   *  by today's team list. */
  readonly catalogKey: string;
  /** True when the saved short name now matches more than one team and there is no permanent
   *  number on file to break the tie. The caller must not guess; the follow should be kept as-is
   *  and the person asked which team they meant. */
  readonly ambiguous: boolean;
  /** When ambiguous, the candidate teams sharing the saved short name, for showing the person a
   *  choice. Empty otherwise. */
  readonly candidates: readonly SourceTeamRef[];
}

/** Resolves one saved follow's stored key against today's live team list. Never throws; an empty
 *  or unavailable team list (a degraded source fetch) resolves to "unresolved, not ambiguous" so a
 *  follow is never flagged as needing a choice just because the list didn't load this time. */
export function resolveFollowIdentity(
  savedTeamKey: string,
  teams: readonly SourceTeamRef[]
): ResolvedTeamIdentity {
  // A saved key still matching a team's current key covers the common cases outright: a short
  // name that is still unique, and a numeric id saved while ambiguous that is still ambiguous.
  const exact = teams.find((team) => team.teamKey === savedTeamKey);
  if (exact) {
    return {
      team: exact,
      sourceTeamId: exact.sourceTeamId,
      catalogKey: exact.teamKey,
      ambiguous: false,
      candidates: []
    };
  }
  // A saved numeric id whose team is no longer ambiguous has a current key of a plain short name,
  // so the check above misses it — but the permanent number is still on file under the team that
  // now goes by that short name (review finding S1, "identity after refresh").
  const byPermanentNumber = teams.find((team) => team.sourceTeamId === savedTeamKey);
  if (byPermanentNumber) {
    return {
      team: byPermanentNumber,
      sourceTeamId: byPermanentNumber.sourceTeamId,
      catalogKey: byPermanentNumber.teamKey,
      ambiguous: false,
      candidates: []
    };
  }
  // Neither a current key nor a permanent number matched, so the saved value must be a short name
  // that has since started being shared (its holder's current key became a number). Check whether
  // it is genuinely shared before giving up — never fall back to matching that raw short name
  // against games or standings, which is exactly the silent-swap this exists to prevent.
  const byShortName = teams.filter((team) => team.abbreviation === savedTeamKey);
  if (byShortName.length > 1) {
    return {
      team: null,
      sourceTeamId: null,
      catalogKey: savedTeamKey,
      ambiguous: true,
      candidates: byShortName
    };
  }
  if (byShortName.length === 1) {
    const team = byShortName[0]!;
    return {
      team,
      sourceTeamId: team.sourceTeamId,
      catalogKey: team.teamKey,
      ambiguous: false,
      candidates: []
    };
  }
  return {
    team: null,
    sourceTeamId: null,
    catalogKey: savedTeamKey,
    ambiguous: false,
    candidates: []
  };
}

/** The identity to hand to game, schedule and standings matching (`followed-card.ts`'s
 *  `sameTeam`): the permanent number when known, so a shared short name on those rows can never
 *  attach to the wrong team, falling back to the saved value only when no number is on file. */
export function matchKeyFor(identity: ResolvedTeamIdentity, savedTeamKey: string): string {
  return identity.sourceTeamId ?? (identity.team ? identity.catalogKey : savedTeamKey);
}
