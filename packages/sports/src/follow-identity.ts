import type { SourceTeamRef } from "./source/sports-source.js";

// A saved follow only ever stored one string (`teamKey`), and the team-identity change (review
// finding S1) means that string can mean three different things depending on when it was saved
// and what the live team list looks like today: the team's still-unique short name, its combined
// short-name-and-number key (saved while its short name was shared with another team), or a short
// name that has SINCE started being shared. Reading the saved string straight off the live list,
// as every call site used to, could silently attach the follow to a different physical team the
// moment a short name stopped being unique. This resolves it once per page load against the live
// list instead, and tells the caller when it genuinely cannot be told apart.
export interface ResolvedTeamIdentity {
  /** The team this follow currently means, or null when it can't be told apart from another team. */
  readonly team: SourceTeamRef | null;
  /** The provider's permanent number for that team, when known. Use this (never a short name) to
   *  match games, schedules and standings rows, which always carry the raw, possibly-shared short
   *  name as their own identity and have no way to know it collided. */
  readonly sourceTeamId: string | null;
  /** The team's identity as it appears in today's team list — a short name, or a short name
   *  joined to a number if that short name is shared right now. Use this to match team-tagged
   *  news, which is already tagged by today's team list. */
  readonly catalogKey: string;
  /** True when the saved value now matches more than one team and there is no permanent number
   *  on file to break the tie. The caller must not guess; the follow should be kept as-is and the
   *  person asked which team they meant. */
  readonly ambiguous: boolean;
  /** When ambiguous, the candidate teams the saved value could mean, for showing the person a
   *  choice. Empty otherwise. */
  readonly candidates: readonly SourceTeamRef[];
  /** True when this was decided against a real, non-empty team list. False when the list did not
   *  load at all, in which case the saved value is all we have and matching stays best-effort. */
  readonly verified: boolean;
}

function resolvedTo(team: SourceTeamRef): ResolvedTeamIdentity {
  return {
    team,
    sourceTeamId: team.sourceTeamId,
    catalogKey: team.teamKey,
    ambiguous: false,
    candidates: [],
    verified: true
  };
}

/** Resolves one saved follow's stored key against today's live team list. Never throws; an empty
 *  or unavailable team list (a degraded source fetch) resolves to "unresolved, not ambiguous" so a
 *  follow is never flagged as needing a choice just because the list didn't load this time. */
export function resolveFollowIdentity(
  savedTeamKey: string,
  teams: readonly SourceTeamRef[]
): ResolvedTeamIdentity {
  if (teams.length === 0) {
    return {
      team: null,
      sourceTeamId: null,
      catalogKey: savedTeamKey,
      ambiguous: false,
      candidates: [],
      verified: false
    };
  }
  // A saved key still matching a team's current key covers the common case outright: a short name
  // that is still unique. A saved value can also be a team's permanent number, either from an
  // older save or from a hand-entered follow.
  // Exact first, and it is genuinely exact: a key this app mints is either a plain short name or
  // a short name joined to a number ("pac.413"), never a bare number, so a saved value that names
  // a team outright can only mean that team even if some other team wears the same digits as its
  // permanent number (review finding S1 blocker 2).
  const exact = teams.find((team) => team.teamKey === savedTeamKey);
  if (exact) return resolvedTo(exact);
  // A follow saved while the short name was shared holds both halves ("pac.413"). Once the other
  // team leaves the list the survivor goes back to its plain short name, so the exact check above
  // misses it — but its number is still on file, and requiring the short name to agree too keeps
  // this from ever landing on a different team.
  const dot = savedTeamKey.lastIndexOf(".");
  if (dot > 0) {
    const shortPart = savedTeamKey.slice(0, dot);
    const numberPart = savedTeamKey.slice(dot + 1);
    const bySavedPair = teams.find(
      (team) => team.sourceTeamId === numberPart && team.abbreviation === shortPart
    );
    if (bySavedPair) return resolvedTo(bySavedPair);
  }
  const byPermanentNumber = teams.find((team) => team.sourceTeamId === savedTeamKey);
  // A saved number whose team is no longer sharing its short name has a current key of a plain
  // short name, so the check above misses it — but the permanent number is still on file under
  // the team that now goes by that short name (review finding S1, "identity after refresh").
  if (byPermanentNumber) return resolvedTo(byPermanentNumber);
  // Neither a current key nor a permanent number matched, so the saved value must be a short name
  // that has since started being shared (its holder's current key gained a number). Check whether
  // it is genuinely shared before giving up — never fall back to matching that raw short name
  // against games or standings, which is exactly the silent swap this exists to prevent.
  const byShortName = teams.filter((team) => team.abbreviation === savedTeamKey);
  if (byShortName.length > 1) {
    return {
      team: null,
      sourceTeamId: null,
      catalogKey: savedTeamKey,
      ambiguous: true,
      candidates: byShortName,
      verified: true
    };
  }
  if (byShortName.length === 1) return resolvedTo(byShortName[0]!);
  return {
    team: null,
    sourceTeamId: null,
    catalogKey: savedTeamKey,
    ambiguous: false,
    candidates: [],
    verified: true
  };
}

/** Everything needed to recognise one followed team on a game, schedule or standings row.
 *  A row comes from its own separate fetch and carries the raw, possibly-shared short name as
 *  its identity; newer rows also carry the provider's permanent number, older cached ones do
 *  not. Carrying both here is what lets a match stay correct across that mix. */
export interface TeamMatchTarget {
  /** The provider's permanent number for this team, when known. */
  readonly sourceTeamId: string | null;
  /** Every short name this team legitimately answers to: its current team-list key, its plain
   *  short name, and the value the follow was saved under. */
  readonly shortNames: readonly string[];
  /** False when no team list loaded, so the short names are the saved value alone and a row
   *  carrying a different team's identical short name cannot be ruled out. */
  readonly verified: boolean;
}

/** The identity to hand to game, schedule and standings matching. Returns null for a follow that
 *  cannot be told apart from another team — that follow must be left out of every match and the
 *  person asked which team they meant instead. */
export function matchTargetFor(
  identity: ResolvedTeamIdentity,
  savedTeamKey: string
): TeamMatchTarget | null {
  if (identity.ambiguous) return null;
  const shortNames = new Set<string>([savedTeamKey]);
  if (identity.team) {
    shortNames.add(identity.team.teamKey);
    if (identity.team.abbreviation) shortNames.add(identity.team.abbreviation);
  }
  return {
    sourceTeamId: identity.sourceTeamId,
    shortNames: [...shortNames],
    verified: identity.verified
  };
}

/** A plain short name used on its own, for the many call sites that legitimately have nothing
 *  else (hand-built fixtures, a single-team lookup inside one already-resolved dataset). */
export function shortNameTarget(teamKey: string): TeamMatchTarget {
  return { sourceTeamId: null, shortNames: [teamKey], verified: false };
}

/** Does this game side or standings row belong to the followed team?
 *
 *  When both sides of the comparison carry the provider's permanent number, only the numbers are
 *  compared — a shared short name can then never attach a score to the wrong team. When the row
 *  predates that number being stored (an older cached game or standings table), fall back to the
 *  short names the team answers to, which is the behaviour that has always shipped and is the
 *  only thing available on such a row. */
export function sideMatchesTarget(
  side: { teamKey: string; sourceTeamId?: string | null },
  target: TeamMatchTarget
): boolean {
  if (target.sourceTeamId != null && side.sourceTeamId != null) {
    return side.sourceTeamId === target.sourceTeamId;
  }
  if (target.shortNames.includes(side.teamKey)) return true;
  return side.sourceTeamId != null && target.shortNames.includes(side.sourceTeamId);
}
