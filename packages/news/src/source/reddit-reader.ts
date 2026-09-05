/**
 * #2282 Shared subreddit reader. A subreddit is read through its public Atom feed,
 * `https://www.reddit.com/r/{name}/hot.rss`, and every entry whose "[link]" anchor points out to a
 * publisher becomes a headline for that article. Ben's ruling (2026-09-03, #2211): use the .rss
 * feed, not the JSON listing. Reddit answers 403 "blocked by network security" for new.json and
 * about.json from a self-hosted box whatever the User-Agent, while the feed answers 200. No API
 * keys, no OAuth, no Reddit HTML scraping.
 *
 * This is the one Reddit reader in the codebase. News owns it; Sports imports it through the
 * `@moss/news` package root (module isolation: declared public API only). Everything here is
 * generic: identity rules, icon hosts and candidate mapping stay with each module.
 */
import { isPublicFeedDocument } from "./rss-source.js";
import { sanitizeFeedText } from "./sanitize.js";

export const REDDIT_CANONICAL_DOMAIN = "reddit.com";
export const REDDIT_FETCH_HOSTS: readonly string[] = ["www.reddit.com"];
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
// Re-exported so every existing importer (and the package root) keeps its current path.
export { REDDIT_AUTH_REQUIRED_MESSAGE, REDDIT_RATE_LIMIT_MESSAGE } from "./reddit-messages.js";

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

export interface RedditRequestHop {
  readonly url: URL;
  readonly redirectCount: number;
}

/** The exact options the reader hands to whichever module's safe fetch executes the call. */
export interface RedditFetchOptions {
  readonly allowedHosts: readonly string[];
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly userAgent: string;
  readonly allowedContentTypes: readonly string[];
  readonly beforeRequest: (hop: RedditRequestHop) => boolean;
  readonly maxBytes: number;
  readonly rejectOversizedResponses: true;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Reddit's robots rules refuse generic agents; the reader asks the host to skip that gate. */
  readonly skipRobots: true;
}

export type RedditFetchResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly finalUrl: string;
      readonly contentType: string | null;
      readonly body: string;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly status?: number;
      readonly detail?: string;
    };

/** Both News' and Sports' safe fetch ports are assignable here without adapters. */
export type RedditFetchPort = (
  url: string,
  options: RedditFetchOptions
) => Promise<RedditFetchResult>;

export interface RedditReaderOptions {
  /**
   * Maps a linked article's hostname to the publisher domain it is credited to. The default
   * strips a leading `www.`; Sports passes its registrable-domain rule so credits match its own
   * publisher identity.
   */
  readonly publisherDomain?: (hostname: string) => string | null;
}

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
export function redditHotFeedUrl(name: string): string {
  return `https://www.reddit.com/r/${name}/hot.rss`;
}

/** The subreddit name inside a saved feed/homepage URL, or null for a non-Reddit URL. */
export function subredditNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const parsed = parseSubredditInput(url);
  return parsed?.kind === "subreddit" ? parsed.name : null;
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

function defaultPublisherDomain(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

function publisherFromLink(
  url: URL,
  options: RedditReaderOptions
): { label: string; domain: string } | null {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || REDDIT_INTERNAL_HOSTS.has(hostname)) return null;
  const mapped = (options.publisherDomain ?? defaultPublisherDomain)(hostname) ?? hostname;
  if (REDDIT_INTERNAL_HOSTS.has(mapped)) return null;
  const domain = mapped.replace(/^www\./, "");
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
export function redditEntryToHeadline(
  entryXml: string,
  options: RedditReaderOptions = {}
): RedditLinkedHeadline | null {
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
  const publisher = publisherFromLink(url, options);
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
  options: RedditReaderOptions & { readonly limit?: number } = {}
): { ok: true; feed: RedditFeed } | { ok: false } {
  if (!isPublicFeedDocument(body) || !/<feed\b/i.test(body)) return { ok: false };
  const limit = options.limit ?? REDDIT_MAX_HEADLINES;
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
    const headline = redditEntryToHeadline(match[1] ?? "", options);
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
export function redditHopGuard(expectedUrl: string): (hop: RedditRequestHop) => boolean {
  const expected = new URL(expectedUrl);
  return (hop) =>
    hop.redirectCount === 0 &&
    !hop.url.port &&
    REDDIT_FETCH_HOSTS.includes(hop.url.hostname.toLowerCase()) &&
    hop.url.pathname === expected.pathname;
}

export function redditFetchOptions(
  url: string,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }
): RedditFetchOptions {
  return {
    allowedHosts: REDDIT_FETCH_HOSTS,
    requestHeaders: REDDIT_ACCEPT_HEADERS,
    allowedContentTypes: REDDIT_CONTENT_TYPES,
    beforeRequest: redditHopGuard(url),
    maxBytes: REDDIT_MAX_RESPONSE_BYTES,
    rejectOversizedResponses: true,
    userAgent: REDDIT_USER_AGENT,
    skipRobots: true,
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.signal ? { signal: options.signal } : {})
  };
}

export type ReadSubredditResult =
  | {
      readonly ok: true;
      readonly subreddit: RedditSubredditInfo;
      readonly headlines: readonly RedditLinkedHeadline[];
      /** The hot feed URL in Reddit's own casing of the name. */
      readonly feedUrl: string;
    }
  | { readonly ok: false; readonly reason: RedditFailureReason };

/** One feed call carries identity and headlines; there is no separate about call. */
export async function readSubreddit(
  fetch: RedditFetchPort,
  name: string,
  options: RedditReaderOptions & {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
): Promise<ReadSubredditResult> {
  const requestUrl = redditHotFeedUrl(name);
  const response = await fetch(requestUrl, redditFetchOptions(requestUrl, options));
  if (!response.ok) return { ok: false, reason: redditFailureReason(response) };
  const parsed = parseRedditFeed(response.body, name, options);
  if (!parsed.ok) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    subreddit: parsed.feed.subreddit,
    headlines: parsed.feed.headlines,
    feedUrl: redditHotFeedUrl(parsed.feed.subreddit.displayName)
  };
}
