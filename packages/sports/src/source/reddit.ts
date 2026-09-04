// #2211 Subreddit sources: input detection, Reddit's public JSON listing/about parsing, and the
// post-to-headline filter. Pure functions plus one fetch helper built on the Sports safe-fetch
// port; no Reddit API keys, no OAuth, no HTML scraping
// (docs/superpowers/specs/2026-09-03-sports-subreddit-sources-and-source-icons.md).

import { sanitizeFeedText } from "@moss/news";

import type { SportsSafeFetchPort, SportsWebRequestHop } from "./discovery.js";
import { publisherIdentity } from "./publisher-identity.js";

export const REDDIT_CANONICAL_DOMAIN = "reddit.com";
export const REDDIT_FETCH_HOSTS: readonly string[] = ["www.reddit.com"];
export const REDDIT_ICON_HOSTS: readonly string[] = [
  "styles.redditmedia.com",
  "b.thumbs.redditmedia.com"
];
export const REDDIT_CONTENT_TYPES: readonly string[] = ["application/json"];
export const REDDIT_ACCEPT_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json"
};
/** Reddit throttles generic agents; the composition root sends this on the two Reddit calls. */
export const REDDIT_USER_AGENT = "Moss/1.0 (self-hosted personal dashboard)";
export const REDDIT_MAX_RESPONSE_BYTES = 1_000_000;
export const REDDIT_MAX_HEADLINES = 40;
export const REDDIT_PREVIEW_SAMPLES = 10;
export const REDDIT_LISTING_LIMIT = 50;
export const REDDIT_RATE_LIMIT_MESSAGE =
  "Reddit is rate limiting Moss. Headlines resume automatically.";
export const REDDIT_AUTH_REQUIRED_MESSAGE = "This subreddit is private or restricted.";

const SUBREDDIT_NAME = /^[A-Za-z0-9_]{3,21}$/;
const SHORT_FORM = /^\/?r\/([^/\s?#]+)\/?$/i;
const URL_FORM = /^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([^/\s?#]+)(?:[/?#].*)?$/i;

/** Hosts whose links point back into Reddit rather than out to a publisher. */
const REDDIT_INTERNAL_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "redd.it",
  "i.redd.it",
  "v.redd.it",
  "preview.redd.it"
]);

export type SubredditInput =
  | { readonly kind: "subreddit"; readonly name: string }
  | { readonly kind: "invalid" };

/**
 * `r/Name`, `/r/Name`, and `https://(www.|old.)reddit.com/r/Name[/...]`. A Reddit-shaped input
 * whose name breaks Reddit's rules answers `invalid` so it never reaches the publication path;
 * anything that is not Reddit-shaped answers null.
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

export function redditListingUrl(name: string): string {
  return `https://www.reddit.com/r/${name}/new.json?limit=${REDDIT_LISTING_LIMIT}`;
}

export function redditAboutUrl(name: string): string {
  return `https://www.reddit.com/r/${name}/about.json`;
}

/** The subreddit name inside a saved listing/homepage URL, or null for a non-Reddit URL. */
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

export interface RedditSubredditAbout {
  readonly displayName: string;
  readonly title: string;
  readonly description: string;
  readonly iconUrl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function publisherFromLink(url: URL): { label: string; domain: string } | null {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || REDDIT_INTERNAL_HOSTS.has(hostname)) return null;
  const registrable = publisherIdentity(hostname) ?? hostname;
  if (REDDIT_INTERNAL_HOSTS.has(registrable)) return null;
  const domain = registrable.replace(/^www\./, "");
  return { label: domain, domain };
}

/**
 * A post is a headline only when it links out: not a self post, not stickied, not a crosspost,
 * hint absent or "link", and the link host is a publisher rather than Reddit or its media hosts.
 */
export function redditPostToHeadline(post: unknown): RedditLinkedHeadline | null {
  const data = asRecord(post);
  if (!data) return null;
  if (data.is_self === true || data.stickied === true) return null;
  if (Array.isArray(data.crosspost_parent_list) && data.crosspost_parent_list.length > 0) {
    return null;
  }
  if (typeof data.crosspost_parent === "string" && data.crosspost_parent.length > 0) return null;
  const hint = data.post_hint;
  if (hint !== undefined && hint !== null && hint !== "link") return null;
  if (typeof data.url !== "string" || typeof data.title !== "string") return null;
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const publisher = publisherFromLink(url);
  if (!publisher) return null;
  const title = sanitizeFeedText(data.title, 500);
  if (!title) return null;
  const created = typeof data.created_utc === "number" ? data.created_utc : null;
  const publishedAt =
    created !== null && Number.isFinite(created) && created > 0
      ? new Date(created * 1000).toISOString()
      : null;
  const id =
    typeof data.name === "string" && data.name
      ? data.name
      : typeof data.id === "string" && data.id
        ? `t3_${data.id}`
        : url.toString();
  return {
    id,
    title,
    url: url.toString(),
    publishedAt,
    publisherLabel: publisher.label,
    publisherDomain: publisher.domain
  };
}

/** `new.json` body to at most `limit` linked-article headlines, newest first as Reddit orders. */
export function parseRedditListing(
  body: string,
  limit = REDDIT_MAX_HEADLINES
): { ok: true; headlines: RedditLinkedHeadline[] } | { ok: false } {
  const root = asRecord(parseJson(body));
  const data = asRecord(root?.data);
  if (root?.kind !== "Listing" || !data || !Array.isArray(data.children)) return { ok: false };
  const headlines: RedditLinkedHeadline[] = [];
  const seen = new Set<string>();
  for (const child of data.children) {
    const record = asRecord(child);
    if (record?.kind !== "t3") continue;
    const headline = redditPostToHeadline(record.data);
    if (!headline || seen.has(headline.url)) continue;
    seen.add(headline.url);
    headlines.push(headline);
    if (headlines.length >= limit) break;
  }
  return { ok: true, headlines };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Query string and HTML entities stripped; only Reddit's own image hosts over HTTPS survive. */
export function redditIconUrlFromAbout(about: Record<string, unknown>): string | null {
  for (const key of ["community_icon", "icon_img"]) {
    const raw = about[key];
    if (typeof raw !== "string" || raw.length === 0) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(raw));
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !REDDIT_ICON_HOSTS.includes(url.hostname.toLowerCase())) {
      continue;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return null;
}

/** `about.json` for a real subreddit is a `t5` node; anything else means it does not exist. */
export function parseRedditAbout(
  body: string,
  fallbackName: string
): { ok: true; about: RedditSubredditAbout } | { ok: false; reason: "not_found" } {
  const root = asRecord(parseJson(body));
  const data = asRecord(root?.data);
  if (root?.kind !== "t5" || !data) return { ok: false, reason: "not_found" };
  const displayName =
    typeof data.display_name === "string" && SUBREDDIT_NAME.test(data.display_name)
      ? data.display_name
      : fallbackName;
  return {
    ok: true,
    about: {
      displayName,
      title: sanitizeFeedText(typeof data.title === "string" ? data.title : "", 120),
      description: sanitizeFeedText(
        typeof data.public_description === "string" ? data.public_description : "",
        300
      ),
      iconUrl: redditIconUrlFromAbout(data)
    }
  };
}

export type RedditFailureReason = "not_found" | "auth_required" | "rate_limited" | "unreachable";

/**
 * Reddit answers 404 for a banned or missing subreddit, 403 for a private or quarantined one,
 * and 429 when throttling. A refused redirect (Reddit sends unknown names to search) is also
 * "not found"; every other failure is a plain outage.
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
      readonly about: RedditSubredditAbout;
      readonly headlines: readonly RedditLinkedHeadline[];
      readonly listingUrl: string;
    }
  | { readonly ok: false; readonly reason: RedditFailureReason };

/** Preview-time read: about.json for identity, then new.json for the sample headlines. */
export async function readSubreddit(
  fetch: SportsSafeFetchPort,
  name: string,
  options?: { readonly signal?: AbortSignal }
): Promise<ReadSubredditResult> {
  const aboutUrl = redditAboutUrl(name);
  const aboutResponse = await fetch(aboutUrl, redditFetchOptions(aboutUrl, options));
  if (!aboutResponse.ok) return { ok: false, reason: redditFailureReason(aboutResponse) };
  const about = parseRedditAbout(aboutResponse.body, name);
  if (!about.ok) return { ok: false, reason: about.reason };

  const listingUrl = redditListingUrl(about.about.displayName);
  const listingResponse = await fetch(listingUrl, redditFetchOptions(listingUrl, options));
  if (!listingResponse.ok) return { ok: false, reason: redditFailureReason(listingResponse) };
  const listing = parseRedditListing(listingResponse.body);
  if (!listing.ok) return { ok: false, reason: "unreachable" };
  return { ok: true, about: about.about, headlines: listing.headlines, listingUrl };
}
