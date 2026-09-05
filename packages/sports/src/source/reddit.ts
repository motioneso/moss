/**
 * #2211 Subreddit sources. A subreddit is read through its public Atom feed,
 * `https://www.reddit.com/r/{name}/hot.rss`, and every entry whose "[link]" anchor points out to a
 * publisher becomes a headline for that article. Ben's ruling (2026-09-03): use the .rss feed, not
 * the JSON listing. Reddit answers 403 "blocked by network security" for new.json and about.json
 * from a self-hosted box whatever the User-Agent, while the feed answers 200. No API keys, no
 * OAuth, no Reddit HTML scraping.
 */
import { isPublicFeedDocument, sanitizeFeedText } from "@moss/news";

import type { SportsSafeFetchPort, SportsWebRequestHop } from "./discovery.js";
import { publisherIdentity } from "./publisher-identity.js";

export const REDDIT_CANONICAL_DOMAIN = "reddit.com";
export const REDDIT_FETCH_HOSTS: readonly string[] = ["www.reddit.com"];
/** Image hosts a stored community icon may point at. Kept for the icon route; the Atom feed only
 *  carries Reddit's generic icon, so confirm stores null today. */
export const REDDIT_ICON_HOSTS: readonly string[] = [
  "styles.redditmedia.com",
  "b.thumbs.redditmedia.com"
];
export const REDDIT_CONTENT_TYPES: readonly string[] = [
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml"
];
export const REDDIT_ACCEPT_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8"
};
/** Reddit throttles generic agents; the composition root sends this on the feed call. */
export const REDDIT_USER_AGENT = "Moss/1.0 (self-hosted personal dashboard)";
export const REDDIT_MAX_RESPONSE_BYTES = 1_000_000;
export const REDDIT_MAX_HEADLINES = 40;
export const REDDIT_PREVIEW_SAMPLES = 10;
export const REDDIT_RATE_LIMIT_MESSAGE =
  "Reddit is rate limiting Moss. Headlines resume automatically.";
export const REDDIT_AUTH_REQUIRED_MESSAGE = "This subreddit is private or restricted.";

const SUBREDDIT_NAME = /^[A-Za-z0-9_]{3,21}$/;
const SHORT_FORM = /^\/?r\/([^/\s?#]+)\/?$/i;
const URL_FORM =
  /^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s?#.]+)(?:\.rss)?(?:[/?#].*)?$/i;

/** Hosts whose links point back into Reddit rather than out to a publisher. */
const REDDIT_INTERNAL_HOSTS = new Set([
  "reddit.com",
  "redd.it",
  "i.redd.it",
  "v.redd.it",
  "preview.redd.it"
]);

export type SubredditInput =
  | { readonly kind: "subreddit"; readonly name: string }
  | { readonly kind: "invalid" };

/**
 * `r/Name`, `/r/Name`, and `https://(www.|old.)reddit.com/r/Name[.rss][/...]`. A Reddit-shaped
 * input whose name breaks Reddit's rules answers `invalid` so it never reaches the publication
 * path; anything that is not Reddit-shaped answers null.
 */
export function parseSubredditInput(raw: string): SubredditInput | null {
  const trimmed = raw.trim();
  const match = SHORT_FORM.exec(trimmed) ?? URL_FORM.exec(trimmed);
  if (!match) return null;
  const name = match[1] ?? "";
  return SUBREDDIT_NAME.test(name) ? { kind: "subreddit", name } : { kind: "invalid" };
}

export function redditSubredditUrl(name: string): string {
  return `https://www.reddit.com/r/${name}/`;
}

/** Reddit's "hot" order (Ben, 2026-09-03: sort subreddits by hot). `/new.rss` would be newest-first. */
export function redditListingUrl(name: string): string {
  return `https://www.reddit.com/r/${name}/hot.rss`;
}

/** The subreddit name inside a saved feed/homepage URL, or null for a non-Reddit URL. */
export function subredditNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const parsed = parseSubredditInput(url);
  return parsed?.kind === "subreddit" ? parsed.name : null;
}

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

export interface RedditLinkedHeadline {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly publisherLabel: string;
  readonly publisherDomain: string;
}

export interface RedditSubredditInfo {
  /** Reddit's own casing of the name, from the feed's category term. */
  readonly displayName: string;
  readonly title: string;
  readonly description: string;
  /** Always null today: the Atom feed only carries Reddit's generic icon. */
  readonly iconUrl: string | null;
}

export interface RedditFeed {
  readonly subreddit: RedditSubredditInfo;
  readonly headlines: RedditLinkedHeadline[];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Text of one XML element: CDATA unwrapped, entities decoded. Null when absent. */
function elementText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return null;
  const inner = match[1] ?? "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  return decodeEntities(cdata ? (cdata[1] ?? "") : inner);
}

function attribute(xml: string, tag: string, name: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, "i").exec(xml);
  return match ? decodeEntities(match[1] ?? "") : null;
}

function publisherFromLink(url: URL): { label: string; domain: string } | null {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || REDDIT_INTERNAL_HOSTS.has(hostname)) return null;
  const registrable = publisherIdentity(hostname) ?? hostname;
  if (REDDIT_INTERNAL_HOSTS.has(registrable)) return null;
  const domain = registrable.replace(/^www\./, "");
  return { label: domain, domain };
}

/** The href of the anchor whose text is "[link]" inside the entry's HTML content. */
export function redditOutboundLink(contentHtml: string): string | null {
  const match = /<a\s[^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i.exec(contentHtml);
  return match ? decodeEntities(match[1] ?? "") : null;
}

/**
 * An Atom entry is a headline only when its "[link]" anchor points out to a publisher rather
 * than back into Reddit or its media hosts. Self posts, images, videos, and galleries all link
 * to Reddit, so the one host rule covers the spec's whole skip list.
 */
export function redditEntryToHeadline(entryXml: string): RedditLinkedHeadline | null {
  const content = elementText(entryXml, "content") ?? elementText(entryXml, "summary") ?? "";
  const rawLink = redditOutboundLink(content);
  const rawTitle = elementText(entryXml, "title");
  if (!rawLink || !rawTitle) return null;
  let url: URL;
  try {
    url = new URL(rawLink);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const publisher = publisherFromLink(url);
  if (!publisher) return null;
  const title = sanitizeFeedText(rawTitle, 500);
  if (!title) return null;
  const stamp = elementText(entryXml, "published") ?? elementText(entryXml, "updated");
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  const publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  const id = elementText(entryXml, "id")?.trim() || url.toString();
  return {
    id,
    title,
    url: url.toString(),
    publishedAt,
    publisherLabel: publisher.label,
    publisherDomain: publisher.domain
  };
}

/**
 * The feed body to the subreddit's identity plus at most `limit` linked-article headlines, in
 * feed order. Not an Atom feed (an HTML block page, an RSS channel from elsewhere) answers not ok.
 */
export function parseRedditFeed(
  body: string,
  fallbackName: string,
  limit = REDDIT_MAX_HEADLINES
): { ok: true; feed: RedditFeed } | { ok: false } {
  if (!isPublicFeedDocument(body) || !/<feed\b/i.test(body)) return { ok: false };
  const entryPattern = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  const firstEntry = entryPattern.exec(body);
  const head = firstEntry ? body.slice(0, firstEntry.index) : body;
  const term = attribute(head, "category", "term");
  const displayName = term && SUBREDDIT_NAME.test(term) ? term : fallbackName;
  const subreddit: RedditSubredditInfo = {
    displayName,
    title: sanitizeFeedText(elementText(head, "title") ?? "", 120),
    description: sanitizeFeedText(elementText(head, "subtitle") ?? "", 300),
    iconUrl: null
  };
  const headlines: RedditLinkedHeadline[] = [];
  const seen = new Set<string>();
  entryPattern.lastIndex = 0;
  for (let match = entryPattern.exec(body); match; match = entryPattern.exec(body)) {
    const headline = redditEntryToHeadline(match[1] ?? "");
    if (!headline || seen.has(headline.url)) continue;
    seen.add(headline.url);
    headlines.push(headline);
    if (headlines.length >= limit) break;
  }
  return { ok: true, feed: { subreddit, headlines } };
}

export type RedditFailureReason = "not_found" | "auth_required" | "rate_limited" | "unreachable";

/**
 * Reddit answers 404 for a banned or missing subreddit, 403 for a private or quarantined one (and
 * for a network-security block), and 429 when throttling. A refused redirect (Reddit sends unknown
 * names to search) is also "not found"; every other failure is a plain outage.
 */
export function redditFailureReason(failure: {
  readonly reason: string;
  readonly status?: number;
  readonly detail?: string;
}): RedditFailureReason {
  if (failure.status === 404) return "not_found";
  if (failure.reason === "blocked") {
    return failure.detail === "unsupported_content_type" ? "unreachable" : "not_found";
  }
  if (failure.status === 401 || failure.status === 403) return "auth_required";
  if (failure.status === 429 || failure.reason === "rate_limited") return "rate_limited";
  return "unreachable";
}

/** Stays on the exact requested path; Reddit's redirect of unknown names to search is refused. */
export function redditHopGuard(expectedUrl: string): (hop: SportsWebRequestHop) => boolean {
  const expected = new URL(expectedUrl);
  return (hop) =>
    hop.redirectCount === 0 &&
    !hop.url.port &&
    REDDIT_FETCH_HOSTS.includes(hop.url.hostname.toLowerCase()) &&
    hop.url.pathname === expected.pathname;
}

export function redditFetchOptions(url: string, options?: { readonly signal?: AbortSignal }) {
  return {
    allowedHosts: REDDIT_FETCH_HOSTS,
    requestHeaders: REDDIT_ACCEPT_HEADERS,
    allowedContentTypes: REDDIT_CONTENT_TYPES,
    beforeRequest: redditHopGuard(url),
    maxBytes: REDDIT_MAX_RESPONSE_BYTES,
    rejectOversizedResponses: true,
    userAgent: REDDIT_USER_AGENT,
    ...(options?.signal ? { signal: options.signal } : {})
  } as const;
}

export type ReadSubredditResult =
  | {
      readonly ok: true;
      readonly subreddit: RedditSubredditInfo;
      readonly headlines: readonly RedditLinkedHeadline[];
      readonly listingUrl: string;
    }
  | { readonly ok: false; readonly reason: RedditFailureReason };

/** One feed call carries identity and headlines; there is no separate about call any more. */
export async function readSubreddit(
  fetch: SportsSafeFetchPort,
  name: string,
  options?: { readonly signal?: AbortSignal }
): Promise<ReadSubredditResult> {
  const requestUrl = redditListingUrl(name);
  const response = await fetch(requestUrl, redditFetchOptions(requestUrl, options));
  if (!response.ok) return { ok: false, reason: redditFailureReason(response) };
  const parsed = parseRedditFeed(response.body, name);
  if (!parsed.ok) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    subreddit: parsed.feed.subreddit,
    headlines: parsed.feed.headlines,
    listingUrl: redditListingUrl(parsed.feed.subreddit.displayName)
  };
}
