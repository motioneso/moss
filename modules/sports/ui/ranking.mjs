/** Story ranking for the news band. Mirrors the rule the server uses to pick the featured story. */

export const EMPTY_FOLLOWED_TEAMS = { byNumber: new Set(), byCatalogKey: new Set() };

export function followedTeamIndex(refs) {
  const byNumber = new Set();
  const byCatalogKey = new Set();
  for (const ref of refs ?? []) {
    if (ref.sourceTeamId == null) continue;
    byNumber.add(`${ref.competitionKey}:${ref.sourceTeamId}`);
    byCatalogKey.add(`${ref.competitionKey}:${ref.teamKey}`);
  }
  return { byNumber, byCatalogKey };
}

/** True when a game side or standings row is a followed team. Only the permanent team id counts. */
export function isFollowed(followed, competitionKey, sourceTeamId) {
  if (sourceTeamId == null) return false;
  return followed.byNumber.has(`${competitionKey}:${sourceTeamId}`);
}

export function isFollowedStoryTeam(followed, competitionKey, teamKey) {
  return followed.byCatalogKey.has(`${competitionKey}:${teamKey}`);
}

export function isWrittenArticle(headline) {
  return headline.url.includes("/story/") || (headline.summary ?? "").length >= 160;
}

export function storyWeight(headline, followed) {
  let weight = 0;
  const competitionKey = headline.competitionKey;
  if (headline.imageUrl) weight += 2;
  if (headline.summary) weight += 1;
  if (competitionKey !== null && (headline.teamKeys ?? []).some((key) => isFollowedStoryTeam(followed, competitionKey, key))) {
    weight += 2;
  }
  return weight;
}

export const BIG_STORY_WEIGHT = 4;

export function rankStories(groups, followed) {
  return groups
    .flatMap((group) =>
      group.headlines.map((headline, feedRank) => ({
        headline,
        weight: storyWeight(headline, followed) + (feedRank === 0 ? 2 : 0)
      }))
    )
    .sort((a, b) => b.weight - a.weight);
}

export const storyKey = (headline) => headline.storyRef || headline.url;
