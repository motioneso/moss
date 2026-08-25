import type { Headline } from "@moss/shared";

import type { ResolvedFollow } from "./followed-groups.js";
import type { SourceHeadline, SourceTeamRef } from "./source/sports-source.js";

const TOP_STORIES_CAP = 6;

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
  const index = headlines.findIndex((headline) => headline.url === incoming.url);
  if (index < 0) return [...headlines, incoming];
  const chosen = headlines[index]!;
  const teamKeys = [...new Set([...chosen.teamKeys, ...incoming.teamKeys])];
  if (teamKeys.length === chosen.teamKeys.length) return [...headlines];
  const merged = [...headlines];
  merged[index] = { ...chosen, teamKeys };
  return merged;
}

function safeHref(url: string): string {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

export function toPublicHeadline(headline: Headline): Headline {
  return {
    id: headline.id,
    competitionKey: headline.competitionKey,
    competitionLabel: headline.competitionLabel,
    title: headline.title,
    url: safeHref(headline.url),
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
  headlinesByComp: ReadonlyMap<string, readonly SourceHeadline[]>,
  followedTeams: readonly ResolvedFollow[],
  followedCompetitionKeys: readonly string[]
): SourceHeadline[] {
  const pairs = new Set(
    followedTeams.map((follow) => `${follow.competitionKey}:${follow.teamKey}`)
  );
  const picked: SourceHeadline[] = [];
  const pickedUrls = new Set<string>();
  for (const competitionKey of followedCompetitionKeys) {
    const lead = (headlinesByComp.get(competitionKey) ?? [])[0];
    if (lead && !pickedUrls.has(lead.url)) {
      picked.push(lead);
      pickedUrls.add(lead.url);
    }
  }
  const remaining = [...headlinesByComp.values()]
    .flatMap((list) => list.map((headline, feedRank) => ({ headline, feedRank })))
    .sort(
      (left, right) =>
        left.feedRank - right.feedRank ||
        right.headline.publishedAt.localeCompare(left.headline.publishedAt)
    );
  for (const { headline } of remaining) {
    if (
      headline.teamKeys.some((key) => pairs.has(`${headline.competitionKey}:${key}`)) &&
      !pickedUrls.has(headline.url)
    ) {
      picked.push(headline);
      pickedUrls.add(headline.url);
    }
  }
  return picked.slice(0, TOP_STORIES_CAP);
}
