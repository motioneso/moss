// packages/news/src/source/newsapi-connection.ts
// #2007 — the single reviewed publisher connection, per the scope lock on the issue
// (2026-08-26): NewsAPI top-headlines, fixed X-Api-Key header, no generic authenticated
// endpoint and no query-string key transport.
import type { NewsTopicKey } from "@moss/shared";

import {
  assertValidPublisherConnectionRegistry,
  type PublisherConnection,
  type SanitizedPublisherItem
} from "./publisher-connection.js";
import { stableIdForUrl } from "./rss-source.js";
import {
  sanitizeFeedText,
  sanitizeItemUrl,
  sanitizePublishedAt,
  SUMMARY_CHAR_CAP,
  TITLE_CHAR_CAP
} from "./sanitize.js";

export const NEWSAPI_CONNECTION_ID = "newsapi-top-headlines";
/** The one dataset this connection serves. Also the keyed runtime's cache dimension. */
export const NEWSAPI_DATASET_KEY = "headlines";

const NEWSAPI_MAX_ITEMS = 20;

/**
 * News topic -> the provider's own vocabulary. Written out in full rather than derived, so the
 * outgoing query string can only ever be one of these value sets. A topic with no equivalent
 * falls back to "default". There is no free-text search value on purpose.
 */
const TOPIC_QUERY: Readonly<Record<NewsTopicKey | "default", Readonly<Record<string, string>>>> =
  Object.freeze({
    default: { category: "general" },
    world: { category: "general" },
    us: { country: "us" },
    politics: { category: "general" },
    business: { category: "business" },
    technology: { category: "technology" },
    science: { category: "science" },
    health: { category: "health" },
    culture: { category: "entertainment" }
  });

interface RawNewsApiArticle {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly publishedAt?: unknown;
  readonly description?: unknown;
  readonly source?: { readonly name?: unknown } | null;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads the documented response shape only. Anything else throws, so a truncated or changed
 * response is reported as a failure rather than as "the publisher had no news today".
 */
function parseNewsApiResponse(
  body: unknown,
  connection: PublisherConnection
): SanitizedPublisherItem[] {
  if (typeof body !== "object" || body === null) {
    throw new Error("newsapi response was not an object");
  }
  const envelope = body as { status?: unknown; articles?: unknown };
  if (envelope.status !== "ok" || !Array.isArray(envelope.articles)) {
    throw new Error("newsapi response was not the documented shape");
  }

  const items: SanitizedPublisherItem[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.articles as RawNewsApiArticle[]) {
    if (items.length >= connection.maxItems) break;
    if (typeof raw !== "object" || raw === null) continue;

    const url = sanitizeItemUrl(asText(raw.url));
    // https only: the provider serves plain-http links for some publishers and those must not
    // reach the page, which is why this is stricter than sanitizeItemUrl alone.
    if (!url || !url.startsWith("https://")) continue;
    const id = stableIdForUrl(url);
    if (seen.has(id)) continue;
    const title = sanitizeFeedText(asText(raw.title), TITLE_CHAR_CAP);
    if (!title) continue;
    seen.add(id);

    items.push({
      id,
      title,
      url,
      publishedAt: sanitizePublishedAt(asText(raw.publishedAt)),
      // No image host is declared for this connection: the provider returns artwork on many
      // unrelated hosts, and widening the allow list is not in this slice's scope. Known gap,
      // recorded for #2006.
      imageUrl: null,
      summary: sanitizeFeedText(asText(raw.description), SUMMARY_CHAR_CAP),
      providerName:
        sanitizeFeedText(asText(raw.source?.name), TITLE_CHAR_CAP) || connection.publisherName
    });
  }
  return items;
}

export const newsApiConnection: PublisherConnection = Object.freeze({
  id: NEWSAPI_CONNECTION_ID,
  publisherName: "NewsAPI",
  canonicalDomain: "newsapi.org",
  homepageUrl: "https://newsapi.org/",
  accessSummary:
    "Reads the top headlines this publisher already publishes. It cannot post, change anything, " +
    "or see the rest of your account.",
  termsUrl: "https://newsapi.org/terms",
  fetchHosts: Object.freeze(["newsapi.org"]),
  endpoint: "https://newsapi.org/v2/top-headlines",
  method: "GET",
  apiKeyHeader: "X-Api-Key",
  fixedQuery: Object.freeze({ language: "en", pageSize: String(NEWSAPI_MAX_ITEMS) }),
  topicQuery: TOPIC_QUERY,
  timeoutMs: 10_000,
  maxResponseBytes: 524_288,
  maxItems: NEWSAPI_MAX_ITEMS,
  minIntervalMs: 1_000,
  parse: parseNewsApiResponse
});

/** The complete set of connections that may ever issue an authenticated request. */
export const PUBLISHER_CONNECTIONS: readonly PublisherConnection[] = Object.freeze([
  newsApiConnection
]);

// Fails at import time rather than at request time: a bad declaration must never reach a fetch.
assertValidPublisherConnectionRegistry(PUBLISHER_CONNECTIONS);

const BY_ID = new Map(PUBLISHER_CONNECTIONS.map((entry) => [entry.id, entry]));

export function publisherConnection(id: string): PublisherConnection | undefined {
  return BY_ID.get(id);
}
