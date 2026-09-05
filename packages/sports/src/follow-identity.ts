import type { SourceTeamRef } from "./source/sports-source.js";

// A saved follow only ever stored one string (`teamKey`), and the team-identity change (review
// finding S1) means that string can mean several different things depending on when it was saved
// and what the live team list looks like today: the team's still-unique short name, its combined
// short-name-and-number key (saved while its short name was shared with another team), the
// provider's permanent number on its own (an older or hand-entered save), or a short name that
// has SINCE started being shared. Reading the saved string straight off the live list, as every
// call site used to, could silently attach the follow to a different physical team the moment a
// short name stopped being unique.
//
// One rule, applied here and nowhere else (S1 re-review 3):
//   * a permanent number on file always outranks a short name;
//   * a short name may pick a team out only when today's list shows exactly one team wearing it;
//   * when the saved value has two possible meanings, or nothing can pick a team out at all, the
//     person is asked which team they meant — the app never guesses.
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
  /** Short names that today's team list proves mean THIS team and no other. Empty when the list
   *  did not load (nothing can be proved) or when the name is shared. Never contains a permanent
   *  number: numbers and short names are separate identity spaces and are never interchanged. */
  readonly safeShortNames: readonly string[];
  /** True when the saved value matches more than one team and there is no permanent number on
   *  file to break the tie. The caller must not guess. */
  readonly ambiguous: boolean;
  /** When ambiguous, the candidate teams the saved value could mean, for showing the person a
   *  choice. Empty otherwise. */
  readonly candidates: readonly SourceTeamRef[];
  /** True when this was decided against a real, non-empty team list. False when the list did not
   *  load at all, in which case nothing about the saved value can be checked. */
  readonly verified: boolean;
  /** True when NOTHING here can safely pick one team out: either the saved value has two possible
   *  meanings, or there is no permanent number and no short name proven to be unique (which is
   *  what an unavailable team list leaves us with). Such a follow must be kept out of every game,
   *  standings and news match, and the person asked which team they meant instead. */
  readonly needsChoice: boolean;
}

function resolvedTo(team: SourceTeamRef, teams: readonly SourceTeamRef[]): ResolvedTeamIdentity {
  const safeShortNames = uniquelyOwnedNames(team, teams);
  return {
    team,
    sourceTeamId: team.sourceTeamId,
    catalogKey: team.teamKey,
    safeShortNames,
    ambiguous: false,
    candidates: [],
    verified: true,
    needsChoice: team.sourceTeamId == null && safeShortNames.length === 0
  };
}

/** The names among a team's own identities (its list key and its short name) that no other team
 *  in today's list answers to. A name any second team wears is dropped: using it would be the
 *  silent wrong-team match this whole module exists to prevent. */
function uniquelyOwnedNames(
  team: SourceTeamRef,
  teams: readonly SourceTeamRef[]
): readonly string[] {
  const candidates = [team.teamKey, team.abbreviation].filter(
    (name): name is string => typeof name === "string" && name.length > 0
  );
  const isThisTeam = (other: SourceTeamRef): boolean =>
    other.teamKey === team.teamKey && other.sourceTeamId === team.sourceTeamId;
  return [...new Set(candidates)].filter((name) =>
    teams.every((other) => isThisTeam(other) || (other.teamKey !== name && other.abbreviation !== name))
  );
}

function unresolved(savedTeamKey: string, verified: boolean): ResolvedTeamIdentity {
  return {
    team: null,
    sourceTeamId: null,
    catalogKey: savedTeamKey,
    // With no team list, the saved value is literally all we have. It is kept so a row that
    // carries nothing but a short name (the only shape older cached data has) can still be
    // recognised, but `verified: false` stops it being used against a row that DOES carry a
    // number — see sideMatchesTarget.
    safeShortNames: verified ? [] : [savedTeamKey],
    ambiguous: false,
    candidates: [],
    verified,
    needsChoice: verified
  };
}

/** Resolves one saved follow's stored key against today's live team list. Never throws. */
export function resolveFollowIdentity(
  savedTeamKey: string,
  teams: readonly SourceTeamRef[]
): ResolvedTeamIdentity {
  // No team list at all (a degraded source fetch, and no cached list ever stored). Nothing about
  // the saved value can be checked, so it is flagged for the recovery prompt and may not be used
  // against any row that carries a permanent number — that is the case that handed a Pacific
  // Lutheran follower a Pacific Tigers score.
  if (teams.length === 0) return unresolved(savedTeamKey, false);

  // The permanent number goes first, ahead of any short-name reading (S1 re-review 3 blocker 2).
  // A saved value that is some team's permanent number is a numbered save until proven otherwise;
  // reading it as a short name first let an old "413" save for Pacific Tigers land on a different
  // club that happens to go by "413".
  const byNumber = teams.filter((team) => team.sourceTeamId === savedTeamKey);
  if (byNumber.length === 1) {
    const numbered = byNumber[0]!;
    // The same string can also be some OTHER team's short name or list key. Two readings, two
    // different teams, no way to tell which the person meant: ask, never guess.
    const rivals = teams.filter(
      (team) =>
        (team.teamKey === savedTeamKey || team.abbreviation === savedTeamKey) &&
        !(team.teamKey === numbered.teamKey && team.sourceTeamId === numbered.sourceTeamId)
    );
    if (rivals.length > 0) {
      return {
        team: null,
        sourceTeamId: null,
        catalogKey: savedTeamKey,
        safeShortNames: [],
        ambiguous: true,
        candidates: [numbered, ...rivals],
        verified: true,
        needsChoice: true
      };
    }
    return resolvedTo(numbered, teams);
  }

  // A saved key still matching a team's current list key covers the common case outright: a short
  // name that is still unique, or a short-name-and-number key saved while it was shared.
  const byKey = teams.filter((team) => team.teamKey === savedTeamKey);
  if (byKey.length === 1) return resolvedTo(byKey[0]!, teams);

  // A follow saved while the short name was shared holds both halves ("pac.413"). Once the other
  // team leaves the list the survivor goes back to its plain short name, so the key check above
  // misses it — but its number is still on file, and requiring the short name to agree too keeps
  // this from ever landing on a different team.
  const dot = savedTeamKey.lastIndexOf(".");
  if (dot > 0) {
    const shortPart = savedTeamKey.slice(0, dot);
    const numberPart = savedTeamKey.slice(dot + 1);
    const bySavedPair = teams.find(
      (team) => team.sourceTeamId === numberPart && team.abbreviation === shortPart
    );
    if (bySavedPair) return resolvedTo(bySavedPair, teams);
  }

  // Left with a plain short name. It may pick a team out only if exactly one team wears it.
  const byShortName = teams.filter((team) => team.abbreviation === savedTeamKey);
  if (byShortName.length > 1) {
    return {
      team: null,
      sourceTeamId: null,
      catalogKey: savedTeamKey,
      safeShortNames: [],
      ambiguous: true,
      candidates: byShortName,
      verified: true,
      needsChoice: true
    };
  }
  if (byShortName.length === 1) return resolvedTo(byShortName[0]!, teams);
  return unresolved(savedTeamKey, true);
}

/** Everything needed to recognise one followed team on a game, schedule or standings row.
 *  A row comes from its own separate fetch and carries the raw, possibly-shared short name as
 *  its identity; newer rows also carry the provider's permanent number, older cached ones do
 *  not. The two halves are kept apart on purpose — a number is never compared against a name. */
export interface TeamMatchTarget {
  /** The provider's permanent number for this team, when known. */
  readonly sourceTeamId: string | null;
  /** Short names proven to mean this team alone. A row may be matched on one of these only when
   *  the numbers cannot settle it. Empty means "no name here is safe to match on". */
  readonly safeShortNames: readonly string[];
  /** False when no team list loaded, so the names above are the saved value taken on trust. Such
   *  a name may not be used against a row that carries a permanent number. */
  readonly verified: boolean;
}

/** The identity to hand to game, schedule and standings matching. Returns null for a follow that
 *  cannot be told apart from another team — that follow must be left out of every match and the
 *  person asked which team they meant instead. */
export function matchTargetFor(identity: ResolvedTeamIdentity): TeamMatchTarget | null {
  if (identity.needsChoice) return null;
  // The saved value itself is deliberately NOT added here. Only names today's team list proved
  // belong to this team alone may be matched on; trusting the saved string on its own is exactly
  // how a follow used to slide onto another club wearing the same short name.
  return {
    sourceTeamId: identity.sourceTeamId,
    safeShortNames: [...identity.safeShortNames],
    verified: identity.verified
  };
}

/** A plain short name used on its own, for the many call sites that legitimately have nothing
 *  else (hand-built fixtures, a single-team lookup inside one already-resolved dataset, where the
 *  caller has already established that the name means one team). */
export function shortNameTarget(teamKey: string): TeamMatchTarget {
  return { sourceTeamId: null, safeShortNames: [teamKey], verified: true };
}

/** Does this game side or standings row belong to the followed team?
 *
 *  Numbers first and numbers only: when both sides of the comparison carry the provider's
 *  permanent number, a shared short name can never attach a score to the wrong team. When the row
 *  predates that number being stored (an older cached game or standings table), a short name may
 *  settle it — but only one of the names today's team list proved belongs to this team alone. A
 *  name two clubs share, or a saved name with no team list behind it and a numbered row in front
 *  of it, withholds the row rather than guessing. */
export function sideMatchesTarget(
  side: { teamKey: string; sourceTeamId?: string | null },
  target: TeamMatchTarget
): boolean {
  if (target.sourceTeamId != null && side.sourceTeamId != null) {
    return side.sourceTeamId === target.sourceTeamId;
  }
  // The row carries a permanent number and the follow has no checked identity to compare it with
  // (the team list did not load). The row's own identity is checkable and we cannot check it, so
  // claiming it on a bare short name would be the guess this module exists to stop.
  if (side.sourceTeamId != null && !target.verified) return false;
  return target.safeShortNames.includes(side.teamKey);
}
