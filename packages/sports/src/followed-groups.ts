import type { SportsFollowDto } from "@moss/shared";

import { catalogEntry } from "./source/catalog.js";

/** A followed-team row narrowed to a real (non-null) `teamKey` — whole-competition follows
 *  (`teamKey: null`) never reach this module; the caller filters them out first (#855). */
export type ResolvedFollow = SportsFollowDto & { teamKey: string };

export interface FollowedTeamGroup {
  readonly key: string;
  readonly follows: readonly ResolvedFollow[];
  readonly primary: ResolvedFollow;
}

// ESPN team ids are scoped to a sport (`espnSport`), not globally unique — the same numeric id
// can name unrelated teams in different sports, so the canonical key must include the sport
// (spec Design §2). Null `sourceTeamId` means "unresolvable" — the caller must never merge that
// row with anything else (spec: "a duplicate card is safer than mixing unrelated clubs that
// share a name").
export function canonicalClubKey(
  follow: ResolvedFollow,
  sourceTeamId: string | null
): string | null {
  if (sourceTeamId === null) return null;
  const espnSport = catalogEntry(follow.competitionKey)?.espnSport;
  return espnSport ? `${espnSport}:${sourceTeamId}` : null;
}

// Primary competition selection (spec Design): league beats tournament outright, regardless of
// recency; only once no league is present (or several tie) does newest `createdAt` decide. ISO
// timestamps sort correctly lexicographically, so string compare is exact. When `createdAt` also
// ties (#903), ascending `id` breaks it, matching SportsFollowsRepository.list()'s secondary
// `ORDER BY id` so the in-memory and database orderings agree on the same winner.
export function selectPrimaryFollow(follows: readonly ResolvedFollow[]): ResolvedFollow {
  const leagues = follows.filter((f) => catalogEntry(f.competitionKey)?.kind === "league");
  const pool = leagues.length > 0 ? leagues : follows;
  return [...pool].sort((a, b) => {
    const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
  })[0]!;
}

/** Groups followed-team rows by canonical club key. A row whose `sourceTeamId` doesn't resolve
 *  becomes its own singleton group, keyed by its own `id` so unresolved rows never accidentally
 *  merge with each other (spec Acceptance Criteria: "not merged by normalized name"). */
export function groupFollowedTeams(
  follows: readonly ResolvedFollow[],
  sourceTeamIdFor: (follow: ResolvedFollow) => string | null
): FollowedTeamGroup[] {
  const byKey = new Map<string, ResolvedFollow[]>();
  for (const follow of follows) {
    const clubKey = canonicalClubKey(follow, sourceTeamIdFor(follow));
    const key = clubKey ?? `unresolved:${follow.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(follow);
    else byKey.set(key, [follow]);
  }
  return [...byKey.entries()].map(([key, groupFollows]) => ({
    key,
    follows: groupFollows,
    primary: selectPrimaryFollow(groupFollows)
  }));
}
