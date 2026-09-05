import type { SourceTeamRef } from "./source/sports-source.js";

// One rule, and it is the whole module (review finding S1, round 5):
//
//   A saved follow means the team whose PERMANENT PROVIDER ID it stored. Nothing else.
//
// Four earlier rounds tried to work out which team a saved short name meant — reading it as a
// short name, as a short-name-and-id key, as a bare id, ranking those readings against each other.
// Every round, the reviewer found another path where the reading picked the wrong team: two
// schools answering "PAC", a club whose short name is another club's id, a team list that failed
// to load. So there is no reading left. A follow saved from today on carries the provider's
// permanent id. A follow saved before this change carries none, and matches NOTHING anywhere —
// no game, no standings row, no briefing fact, no story — until the person is asked once which
// team they meant and picks. The saved short name is read in exactly one place, to put the likely
// teams first in that question, and it can never select a team on its own or hide any other team
// from the list (review finding S1, round 6).
export interface ResolvedTeamIdentity {
  /** The team this follow means, looked up in today's team list by permanent id. Null when no id
   *  is stored, or when today's list has no team with that id. */
  readonly team: SourceTeamRef | null;
  /** The permanent id stored on the follow. Null on a follow saved before round 5. */
  readonly sourceTeamId: string | null;
  /** The identity today's team list gives that team, which is also what team-tagged news is
   *  tagged with. Null whenever the team could not be found by id. */
  readonly catalogKey: string | null;
  /** True when no permanent id is stored, so this follow must be kept out of every match and the
   *  person asked which team they meant. */
  readonly needsChoice: boolean;
  /** Teams to offer as the answer to that question: every team in today's list, with the ones
   *  whose short name is the saved one first. Empty when the list did not load, which is also
   *  what `teamListLoaded` reports. */
  readonly candidates: readonly SourceTeamRef[];
  /** False when today's team list did not load at all, so no choice can be offered yet. */
  readonly teamListLoaded: boolean;
}

/** Resolves one saved follow against today's team list. Never throws. */
export function resolveFollowIdentity(
  saved: { readonly teamKey: string | null; readonly sourceTeamId: string | null },
  teams: readonly SourceTeamRef[]
): ResolvedTeamIdentity {
  const teamListLoaded = teams.length > 0;
  if (saved.sourceTeamId !== null) {
    const team = teams.find((candidate) => candidate.sourceTeamId === saved.sourceTeamId) ?? null;
    return {
      team,
      sourceTeamId: saved.sourceTeamId,
      // Only a team found by its permanent id lends its list key here. A follow whose team is not
      // in today's list gets no key, so it cannot borrow a key another team is using.
      catalogKey: team?.teamKey ?? null,
      needsChoice: false,
      candidates: [],
      teamListLoaded
    };
  }
  // No permanent id: an older save. The saved short name is used ONLY to ORDER the teams the
  // person is offered, never to shorten the list and never to pick one (review finding S1, round
  // 6). Hiding the teams that do not answer to the saved short name looked helpful and was not:
  // an older Tigers save of "413" was offered only the club literally named 413, and the person
  // could not reach the team they actually meant. Every team in the competition stays reachable;
  // the ones answering to the saved name simply come first.
  const savedShortName = saved.teamKey;
  const answersToSavedName = (team: SourceTeamRef): boolean =>
    savedShortName !== null &&
    (team.abbreviation === savedShortName || team.teamKey === savedShortName);
  const candidates = [
    ...teams.filter((team) => answersToSavedName(team)),
    ...teams.filter((team) => !answersToSavedName(team))
  ];
  return {
    team: null,
    sourceTeamId: null,
    catalogKey: null,
    needsChoice: true,
    candidates,
    teamListLoaded
  };
}

/** The identity to hand to game, schedule and standings matching: a permanent provider id, or
 *  nothing at all. */
export interface TeamMatchTarget {
  readonly sourceTeamId: string;
}

/** Returns null for a follow that has no permanent id — that follow is left out of every match
 *  and the person asked which team they meant instead. */
export function matchTargetFor(identity: ResolvedTeamIdentity): TeamMatchTarget | null {
  if (identity.sourceTeamId === null) return null;
  return { sourceTeamId: identity.sourceTeamId };
}

/** Does this game side or standings row belong to the followed team? Permanent ids on both sides
 *  or no match at all. A row that carries no id (an older cached game or standings table) can no
 *  longer be claimed by anyone: claiming it would mean comparing short names, and comparing short
 *  names is what handed a Pacific Lutheran follower a Pacific Tigers score. */
export function sideMatchesTarget(
  side: { readonly teamKey: string; readonly sourceTeamId?: string | null },
  target: TeamMatchTarget
): boolean {
  return side.sourceTeamId != null && side.sourceTeamId === target.sourceTeamId;
}
