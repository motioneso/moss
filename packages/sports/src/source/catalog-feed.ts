import type { DatasetCache } from "@moss/datasets";
import { DEFAULT_STALE_RETENTION_MS } from "@moss/datasets";
import { isPublicFeedDocument, parsePublicFeedItems } from "@moss/news";

import { catalogEntry } from "./catalog.js";
import type { SportsSafeFetchPort } from "./discovery.js";
import {
  DomainConcurrencyLimiter,
  FETCH_TIMEOUT_MS,
  HEADLINE_TTL_MS,
  MAX_RESPONSE_BYTES,
  REFRESH_DEADLINE_MS
} from "./feed-shared.js";
import type { ExtractedHeadline, SportsPublicSourceHeadline } from "./public-source-reader.js";

const ACCEPT_HEADERS = {
  accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.9"
};
const ACCEPTED_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/plain"
];

/**
 * #2661: news for competitions that declare a fixed `newsFeedUrl` in the catalog (there is no
 * ESPN data for them, so the feed is their only content). This is the same safe-fetch + feed
 * parse + cache path the custom-source reader uses, just with the URL coming from static catalog
 * data instead of a saved source. Only competitions the viewer actually follows are fetched; a
 * failure yields no stories rather than degrading the whole page. Lives outside the reader so the
 * reader file stays under the repository's size limit.
 */
export async function readCatalogFeeds(params: {
  readonly competitionKeys: readonly string[];
  readonly fetch: SportsSafeFetchPort;
  readonly cache: DatasetCache;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}): Promise<readonly SportsPublicSourceHeadline[]> {
  const { fetch, cache, now, signal } = params;
  const wanted = [...new Set(params.competitionKeys)]
    .map((key) => ({ key, entry: catalogEntry(key) }))
    .filter((item): item is { key: string; entry: NonNullable<ReturnType<typeof catalogEntry>> } =>
      Boolean(item.entry?.newsFeedUrl)
    );
  if (wanted.length === 0) return [];
  const deadline = now() + REFRESH_DEADLINE_MS;
  const limiter = new DomainConcurrencyLimiter();
  const headlines: SportsPublicSourceHeadline[] = [];
  await Promise.all(
    wanted.map(async ({ key, entry }) => {
      const url = entry.newsFeedUrl as string;
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return;
      }
      const cacheKey = `catalog-feed:${url}`;
      const cached = signal ? undefined : cache.get<readonly ExtractedHeadline[]>(cacheKey, now());
      let items = cached?.fresh ? cached.value : null;
      if (!items) {
        const held = await limiter.acquireAll([host], deadline, now, signal);
        if (!held) return;
        let response: Awaited<ReturnType<SportsSafeFetchPort>>;
        try {
          response = await fetch(url, {
            allowedHosts: [host],
            requestHeaders: ACCEPT_HEADERS,
            allowedContentTypes: ACCEPTED_CONTENT_TYPES,
            beforeRequest: (hop) => hop.url.port === "" && hop.url.hostname.toLowerCase() === host,
            maxBytes: MAX_RESPONSE_BYTES,
            rejectOversizedResponses: true,
            timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(1, deadline - now())),
            signal
          });
        } catch {
          return;
        } finally {
          for (const value of held) limiter.release(value);
        }
        if (!response.ok || !isPublicFeedDocument(response.body)) return;
        const fetchedAt = new Date(now()).toISOString();
        items = parsePublicFeedItems(response.body).map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt ?? fetchedAt,
          summary: item.summary
        }));
        const cachedAt = now();
        cache.set(
          cacheKey,
          items,
          cachedAt + HEADLINE_TTL_MS,
          cachedAt + HEADLINE_TTL_MS + DEFAULT_STALE_RETENTION_MS
        );
      }
      const fallbackTime = new Date(now()).toISOString();
      for (const item of items) {
        headlines.push({
          origin: "custom",
          sourceId: `catalog:${key}`,
          id: `catalog:${key}:${item.id}`,
          sportKey: entry.espnSport,
          competitionKey: key,
          competitionLabel: entry.label,
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt ?? fallbackTime,
          imageUrl: null,
          imageWidth: null,
          imageHeight: null,
          summary: item.summary,
          teamKeys: [],
          publisherLabel: entry.label,
          publisherDomain: host
        });
      }
    })
  );
  return headlines;
}
