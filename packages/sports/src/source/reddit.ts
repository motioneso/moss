/**
 * #2211 Subreddit sources. The reader itself moved to @moss/news in #2282 so News and Sports
 * share one implementation through the declared package API. This file keeps the Sports-only
 * pieces (icon hosts, the saved-source identity rule) and re-exports the shared reader under the
 * names the rest of Sports already uses.
 */
export {
  parseRedditFeed,
  parseSubredditInput,
  readSubreddit,
  REDDIT_ACCEPT_HEADERS,
  REDDIT_AUTH_REQUIRED_MESSAGE,
  REDDIT_CANONICAL_DOMAIN,
  REDDIT_CONTENT_TYPES,
  REDDIT_FETCH_HOSTS,
  REDDIT_MAX_HEADLINES,
  REDDIT_MAX_RESPONSE_BYTES,
  REDDIT_PREVIEW_SAMPLES,
  REDDIT_RATE_LIMIT_MESSAGE,
  REDDIT_USER_AGENT,
  redditEntryToHeadline,
  redditFailureReason,
  redditFetchOptions,
  redditHopGuard,
  redditHotFeedUrl,
  redditOutboundLink,
  redditSubredditUrl,
  subredditNameFromUrl
} from "@moss/news";
export type {
  ReadSubredditResult,
  RedditFailureReason,
  RedditFeed,
  RedditLinkedHeadline,
  RedditSubredditInfo,
  SubredditInput
} from "@moss/news";

import { subredditNameFromUrl } from "@moss/news";

/** Image hosts a stored community icon may point at. Kept for the icon route; the Atom feed only
 *  carries Reddit's generic icon, so confirm stores null today. */
export const REDDIT_ICON_HOSTS: readonly string[] = [
  "styles.redditmedia.com",
  "b.thumbs.redditmedia.com"
];

/**
 * The key two saved sources are compared on. Publications collide on canonical domain; two
 * subreddits collide on their lower-cased name, so r/nfl and r/NFL are one source while r/nfl
 * and r/nba both live under reddit.com.
 */
export function sportsSourceIdentityKey(source: {
  readonly retrievalMethod: string;
  readonly canonicalDomain: string;
  readonly feedUrl?: string | null;
  readonly homepageUrl?: string | null;
}): string {
  if (source.retrievalMethod === "reddit") {
    const name = subredditNameFromUrl(source.feedUrl) ?? subredditNameFromUrl(source.homepageUrl);
    if (name) return `reddit:${name.toLowerCase()}`;
  }
  return `domain:${source.canonicalDomain}`;
}
