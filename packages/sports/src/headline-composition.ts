import type { Headline, SportsSportKey } from "@moss/shared";

import type { ResolvedFollow } from "./followed-groups.js";
import { catalogEntry } from "./source/catalog.js";
import { SPORTS_SPORT_LABELS } from "./source/scope.js";
import type { SourceHeadline, SourceTeamRef } from "./source/sports-source.js";

const TOP_STORIES_CAP = 6;

export type SourceNewsGroup =
  | {
      readonly kind: "sport";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: null;
      readonly competitionLabel: string;
      readonly headlines: readonly SourceHeadline[];
    }
  | {
      readonly kind: "competition";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: string;
      readonly competitionLabel: string;
      readonly headlines: readonly SourceHeadline[];
    };

export function canonicalStoryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function resolveEspnHeadlineTeamKeys(
  headlines: readonly SourceHeadline[],
  teams: readonly SourceTeamRef[]
): SourceHeadline[] {
  const byId = new Map<string, string>();
  for (const team of teams) {
    if (team.sourceTeamId !== null) byId.set(team.sourceTeamId, team.teamKey);
  }
  return headlines.map((headline) =>
    headline.origin === "custom"
      ? headline
      : {
          ...headline,
          teamKeys: headline.sourceTeamIds
            .map((id) => byId.get(id))
            .filter((key): key is string => key !== undefined)
        }
  );
}

export function mergeHeadlineScope(
  headlines: readonly SourceHeadline[],
  incoming: SourceHeadline
): SourceHeadline[] {
  const incomingUrl = canonicalStoryUrl(incoming.url);
  const index = headlines.findIndex(
    (headline) => canonicalStoryUrl(headline.url) === incomingUrl && incomingUrl !== null
  );
  if (index < 0) return [...headlines, incoming];
  const chosen = headlines[index]!;
  const teamKeys = [...new Set([...chosen.teamKeys, ...incoming.teamKeys])];
  if (teamKeys.length === chosen.teamKeys.length) return [...headlines];
  const merged = [...headlines];
  merged[index] = { ...chosen, teamKeys };
  return merged;
}

export function deduplicateNewsGroups(groups: readonly SourceNewsGroup[]): SourceNewsGroup[] {
  const seen = new Set<string>();
  return groups.flatMap((group) => {
    const headlines = group.headlines.filter((headline) => {
      const url = canonicalStoryUrl(headline.url);
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
    return headlines.length > 0 ? [{ ...group, headlines }] : [];
  });
}

export function composeSportsNewsGroups(
  headlinesBySport: ReadonlyMap<SportsSportKey, readonly SourceHeadline[]>,
  headlinesByCompetition: ReadonlyMap<string, readonly SourceHeadline[]>,
  competitionKeys: readonly string[]
): SourceNewsGroup[] {
  const sportGroups: SourceNewsGroup[] = [...headlinesBySport].map(([sportKey, headlines]) => ({
    kind: "sport",
    sportKey,
    competitionKey: null,
    competitionLabel: SPORTS_SPORT_LABELS[sportKey],
    headlines
  }));
  const competitionGroups: SourceNewsGroup[] = competitionKeys.flatMap((competitionKey) => {
    const competition = catalogEntry(competitionKey);
    return competition
      ? [
          {
            kind: "competition",
            sportKey: competition.espnSport,
            competitionKey,
            competitionLabel: competition.label,
            headlines: headlinesByCompetition.get(competitionKey) ?? []
          }
        ]
      : [];
  });
  return deduplicateNewsGroups([...sportGroups, ...competitionGroups]);
}

export function toPublicHeadline(headline: SourceHeadline): Headline {
  const sportKey =
    headline.sportKey ??
    (headline.competitionKey ? catalogEntry(headline.competitionKey)?.espnSport : undefined);
  if (!sportKey) throw new Error("Sports headline has no catalog sport scope");
  return {
    id: headline.id,
    sportKey,
    competitionKey: headline.competitionKey,
    competitionLabel: headline.competitionLabel,
    title: headline.title,
    url: canonicalStoryUrl(headline.url) ?? "",
    publishedAt: headline.publishedAt,
    imageUrl: headline.imageUrl,
    summary: headline.summary,
    teamKeys: headline.teamKeys,
    publisherLabel: headline.publisherLabel,
    publisherDomain: headline.publisherDomain,
    ...(headline.body === undefined ? {} : { body: headline.body })
  };
}

export function rankTopStories(
  groups: readonly SourceNewsGroup[],
  followedTeams: readonly ResolvedFollow[]
): SourceHeadline[] {
  const pairs = new Set(
    followedTeams.map((follow) => `${follow.competitionKey}:${follow.teamKey}`)
  );
  const picked: SourceHeadline[] = [];
  const pickedUrls = new Set<string>();
  for (const group of groups) {
    const lead = group.headlines[0];
    if (lead && !pickedUrls.has(lead.url)) {
      picked.push(lead);
      pickedUrls.add(lead.url);
    }
  }
  const remaining = groups
    .flatMap((group) => group.headlines.map((headline, feedRank) => ({ headline, feedRank })))
    .sort(
      (left, right) =>
        left.feedRank - right.feedRank ||
        right.headline.publishedAt.localeCompare(left.headline.publishedAt)
    );
  for (const { headline } of remaining) {
    if (
      headline.competitionKey !== null &&
      headline.teamKeys.some((key) => pairs.has(`${headline.competitionKey}:${key}`)) &&
      !pickedUrls.has(headline.url)
    ) {
      picked.push(headline);
      pickedUrls.add(headline.url);
    }
  }
  return picked.slice(0, TOP_STORIES_CAP);
}
