// Pure NewsBand story-ranking logic, shared by the web tier (client render) and the sports
// service (server-side body fetch). NO React, NO node deps — importable from both sides.
//
// Why this module exists (#857): the "featured hero" is picked CLIENT-side in NewsBand by ranking
// headlines. To attach the fetched article body to the EXACT story the client will feature, the
// server has to compute the identical pick. Extracting the ranking here — and having both callers
// use it — is what guarantees they never diverge (a private copy on each side would drift and the
// body would end up on the wrong article). Deliberately clock-free so SSR and tests stay
// deterministic; ties fall back to feed order (roughly ESPN's editorial prominence).

import type { Headline, SportsNewsGroup } from "@moss/shared";

export function isFollowed(
  pairs: ReadonlySet<string>,
  competitionKey: string,
  teamKey: string
): boolean {
  return pairs.has(`${competitionKey}:${teamKey}`);
}

// Written-article detector (mrb5reqq "some can have more text (especially if they are a written
// article)"): ESPN's written pieces live under /story/ URLs while clips live under /video/; a long
// dek is the fallback signal for sources that don't encode type in the URL.
export function isWrittenArticle(headline: Headline): boolean {
  return headline.url.includes("/story/") || headline.summary.length >= 160;
}

// "Big story" heuristic (live feedback mrb47x3h): we have no editorial prominence signal from the
// source, so weight what we do have — art (+2) and a dek (+1) mean the source invested in the
// story; a followed-team tag (+2) means this reader cares. NOTE: intentionally does NOT consider
// `body` (#857) — body is fetched only AFTER the feature is chosen, so including it here would make
// the pick depend on data it can't have yet and desync server vs client.
export function storyWeight(headline: Headline, followedPairs: ReadonlySet<string>): number {
  let weight = 0;
  const competitionKey = headline.competitionKey;
  if (headline.imageUrl) weight += 2;
  if (headline.summary) weight += 1;
  if (
    competitionKey !== null &&
    headline.teamKeys.some((key) => isFollowed(followedPairs, competitionKey, key))
  ) {
    weight += 2;
  }
  return weight;
}

// Feature/big threshold: art alone (2) or art+dek (3) is ordinary; it takes a followed-team story
// with art (4+) to break the column grid. Keeps the feature slot personal, not just loud.
export const BIG_STORY_WEIGHT = 4;

export interface RankedStory {
  readonly headline: Headline;
  readonly weight: number;
}

// The one ranking both sides run. Each league's FIRST headline gets a +2 editorial bonus: the
// server preserves ESPN's feed order (their front-page prominence ranking), so the front slot IS
// the big story (mrb51pnq). Sort is stable, so equal weights keep league order across leagues and
// feed order within one — deterministic for SSR and tests.
export function rankStories(
  groups: readonly SportsNewsGroup[],
  followedPairs: ReadonlySet<string>
): RankedStory[] {
  return groups
    .flatMap((group) =>
      group.headlines.map((headline, feedRank) => ({
        headline,
        weight: storyWeight(headline, followedPairs) + (feedRank === 0 ? 2 : 0)
      }))
    )
    .sort((a, b) => b.weight - a.weight);
}

// The single featured hero, or null on a quiet day. Heaviest story overall, first-found on ties
// (stable sort), gated by BIG_STORY_WEIGHT. The server calls this over ALL groups (the client's
// default "all" filter state) to know which article's body to fetch (#857); NewsBand computes the
// same pick from `rankStories` for its own filtered view.
export function selectFeature(
  groups: readonly SportsNewsGroup[],
  followedPairs: ReadonlySet<string>
): Headline | null {
  const ranked = rankStories(groups, followedPairs);
  return ranked[0] && ranked[0].weight >= BIG_STORY_WEIGHT ? ranked[0].headline : null;
}
