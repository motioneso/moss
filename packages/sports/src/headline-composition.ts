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

/**
 * Builds the opaque per-story feedback reference from a story's canonical link (#2019). Injected
 * rather than imported: the hash lives in the usefulness-feedback package, and Sports must not
 * reach into another module's internals (CLAUDE.md, module isolation). The composition root binds
 * it; every caller here treats it as optional so a service built without the port is unchanged.
 */
export type StoryRefFor = (canonicalLink: string) => string;

/**
 * `{ storyRef }` when a reference can be built, `{}` otherwise, so the field is simply absent
 * rather than present-and-empty. Keyed on the CANONICAL link, which is why the same story reached
 * from a league feed and from a team feed carries one reference.
 */
export function storyRefFields(
  url: string,
  refFor: StoryRefFor | undefined
): { storyRef?: string } {
  if (!refFor) return {};
  const canonical = canonicalStoryUrl(url);
  if (!canonical) return {};
  try {
    return { storyRef: refFor(canonical) };
  } catch {
    // A link the hash refuses (empty after normalising) must not take the whole page down; the
    // story simply renders without a feedback menu.
    return {};
  }
}

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

export function toPublicHeadline(headline: SourceHeadline, refFor?: StoryRefFor): Headline {
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
    ...(headline.imageWidth == null ? {} : { imageWidth: headline.imageWidth }),
    ...(headline.imageHeight == null ? {} : { imageHeight: headline.imageHeight }),
    summary: headline.summary,
    teamKeys: headline.teamKeys,
    publisherLabel: headline.publisherLabel,
    publisherDomain: headline.publisherDomain,
    ...(headline.body === undefined ? {} : { body: headline.body }),
    ...storyRefFields(headline.url, refFor)
  };
}

/**
 * Top stories, in two tiers: each group's editorial lead first, then followed-team stories by
 * feed rank.
 *
 * `liftFor` is the "more like this" nudge (#2019), and it applies to the SECOND tier only. Tier
 * one is each league's own editorial lead, and a positive preference must never buy a place
 * there — that is what keeps a preference a nudge rather than a takeover. The league news band on
 * the client keeps its own ranking; in this slice a lift is a server-side top-stories effect and
 * nothing else.
 */
export function rankTopStories(
  groups: readonly SourceNewsGroup[],
  followedTeams: readonly ResolvedFollow[],
  liftFor?: (headline: SourceHeadline) => number
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
    .flatMap((group) =>
      group.headlines.map((headline, feedRank) => ({
        headline,
        feedRank: feedRank - (liftFor?.(headline) ?? 0)
      }))
    )
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
