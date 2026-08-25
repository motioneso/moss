import {
  SPORTS_SOURCE_ASSIGNMENT_LIMIT,
  type SportsFollowDto,
  type SportsSourceAssignmentTarget,
  type SportsSportKey
} from "@moss/shared";

import { SPORTS_CATALOG } from "./catalog.js";

export const SPORTS_SPORT_LABELS = {
  football: "Football",
  hockey: "Hockey",
  soccer: "Soccer",
  baseball: "Baseball",
  basketball: "Basketball"
} as const satisfies Record<SportsSportKey, string>;

export interface SportsSportOption {
  readonly key: SportsSportKey;
  readonly label: string;
}

export type SportsNewsScope =
  | { readonly kind: "sport"; readonly sportKey: SportsSportKey }
  | {
      readonly kind: "competition";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: string;
    }
  | {
      readonly kind: "team";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: string;
      readonly teamKey: string;
    };

const catalogSportKeys = new Set(SPORTS_CATALOG.map((entry) => entry.espnSport));

export function sportsSportOptions(): readonly SportsSportOption[] {
  return [...catalogSportKeys].map((key) => ({ key, label: SPORTS_SPORT_LABELS[key] }));
}

export function isSportsSportKey(value: string): value is SportsSportKey {
  return catalogSportKeys.has(value as SportsSportKey);
}

export function sportsSourceTargetKey(target: SportsSourceAssignmentTarget): string {
  return target.kind === "sport" ? `sport:${target.sportKey}` : `follow:${target.followId}`;
}

export function hasValidSportsSourceTargets(
  targets: readonly SportsSourceAssignmentTarget[]
): boolean {
  if (targets.length > SPORTS_SOURCE_ASSIGNMENT_LIMIT) return false;
  const keys = targets.map(sportsSourceTargetKey);
  return (
    new Set(keys).size === keys.length &&
    targets.every((target) =>
      target.kind === "sport" ? isSportsSportKey(target.sportKey) : target.followId.length > 0
    )
  );
}

export function sportsNewsScopeCovers(
  assignment: SportsNewsScope,
  requested: SportsNewsScope
): boolean {
  if (assignment.sportKey !== requested.sportKey) return false;
  if (assignment.kind === "sport") return true;
  if (requested.kind === "sport" || assignment.competitionKey !== requested.competitionKey) {
    return false;
  }
  if (assignment.kind === "competition") return true;
  return requested.kind === "team" && assignment.teamKey === requested.teamKey;
}

export function sportsNewsScopeForFollow(
  follow: Pick<SportsFollowDto, "competitionKey" | "teamKey">
): SportsNewsScope | null {
  const sportKey = SPORTS_CATALOG.find(
    (entry) => entry.competitionKey === follow.competitionKey
  )?.espnSport;
  if (!sportKey) return null;
  return follow.teamKey
    ? { kind: "team", sportKey, competitionKey: follow.competitionKey, teamKey: follow.teamKey }
    : { kind: "competition", sportKey, competitionKey: follow.competitionKey };
}

export function sportsNewsCoverageAllows(
  coverage: {
    readonly enabled: boolean;
    readonly usesDefaultCoverage: boolean;
    readonly assignments: readonly SportsSourceAssignmentTarget[];
  },
  follows: readonly SportsFollowDto[],
  requested: SportsNewsScope
): boolean {
  if (!coverage.enabled) return false;
  if (coverage.usesDefaultCoverage) return true;
  const byId = new Map(follows.map((follow) => [follow.id, follow]));
  return coverage.assignments.some((target) => {
    const follow = target.kind === "follow" ? byId.get(target.followId) : undefined;
    const assignment =
      target.kind === "sport"
        ? ({ kind: "sport", sportKey: target.sportKey } as const)
        : follow
          ? sportsNewsScopeForFollow(follow)
          : null;
    return assignment !== null && sportsNewsScopeCovers(assignment, requested);
  });
}
