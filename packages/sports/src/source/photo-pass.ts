import type { SportsSafeFetchPort } from "./discovery.js";
import { applySportsPhotoRule, type SportsPhotoRule } from "./photo-rule.js";
import {
  extractFeedPhoto,
  extractShareImage,
  isUsablePhotoCandidate,
  parseFeedPhotoItems
} from "./photo.js";
import { SPORTS_PHOTO_DEADLINE_MARGIN_MS } from "./photo-store.js";
import type {
  DomainConcurrencyLimiter,
  ExtractedHeadline,
  RequestGroup
} from "./public-source-reader.js";
import { FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./public-source-reader.js";

/**
 * #2237 the pass that puts a photo on a story before it is stored. It lives beside the reader
 * rather than inside it because the reader is already at the size the repository allows.
 */

/** How many article pages one source may be asked for in a single refresh. */
const MAX_ARTICLE_PAGE_FETCHES = 6;
const PHOTO_DEADLINE_MARGIN_MS = SPORTS_PHOTO_DEADLINE_MARGIN_MS;
const ARTICLE_PAGE_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

/**
 * #2237 the deterministic photo pass: the feed's own media tag first, then the instruction Moss
 * found for this publisher if there is one, then the article page's share image. Every failure here is swallowed — a story without a photo is still a story, and
 * a photo must never cost the reader its headlines.
 */
export async function attachSportsPhotoUrls(
  group: RequestGroup,
  items: readonly ExtractedHeadline[],
  feedBody: string | null,
  context: {
    readonly deadline: number;
    readonly signal?: AbortSignal;
    readonly domainLimiter: DomainConcurrencyLimiter;
    readonly pageBudget: Map<string, number>;
    readonly now: () => number;
    readonly fetch: SportsSafeFetchPort;
  }
): Promise<readonly ExtractedHeadline[]> {
  const feedPhotos = new Map<string, string>();
  if (feedBody !== null) {
    for (const parsed of parseFeedPhotoItems(feedBody)) {
      if (!parsed.link) continue;
      const found = extractFeedPhoto(parsed);
      if (found) feedPhotos.set(parsed.link, found.url);
    }
  }
  const sourceIds = new Set(group.assignments.map((pair) => pair.source.id));
  // A saved instruction only ever runs on the publisher hosts it was verified against, so it is
  // looked up by the host of the article about to be fetched.
  const savedRules = new Map<string, SportsPhotoRule>();
  for (const pair of group.assignments) {
    const rule = pair.source.photoRule;
    if (!rule) continue;
    for (const host of rule.fetchHosts) if (!savedRules.has(host)) savedRules.set(host, rule);
  }
  const withPhotos: ExtractedHeadline[] = [];
  for (const item of items) {
    let publisherHost: string;
    try {
      publisherHost = new URL(item.url).hostname.toLowerCase();
    } catch {
      withPhotos.push(item);
      continue;
    }
    const fromFeed = feedPhotos.get(item.url);
    if (fromFeed && isUsablePhotoCandidate(fromFeed, { publisherHost })) {
      withPhotos.push({ ...item, photoUrl: fromFeed });
      continue;
    }
    const budgetLeft = [...sourceIds].every(
      (sourceId) => (context.pageBudget.get(sourceId) ?? 0) < MAX_ARTICLE_PAGE_FETCHES
    );
    if (
      !budgetLeft ||
      context.signal?.aborted ||
      context.now() + PHOTO_DEADLINE_MARGIN_MS >= context.deadline
    ) {
      withPhotos.push(item);
      continue;
    }
    for (const sourceId of sourceIds) {
      context.pageBudget.set(sourceId, (context.pageBudget.get(sourceId) ?? 0) + 1);
    }
    const found = await fetchArticlePhoto(
      item.url,
      publisherHost,
      savedRules.get(publisherHost) ?? null,
      context
    );
    withPhotos.push(found ? { ...item, photoUrl: found } : item);
  }
  return withPhotos;
}

/**
 * Fetches one article page and asks it for a photo twice over: first with the instruction Moss
 * found for this publisher, if there is one, then with the page's own share image. Both come
 * out of the same single fetch, so a saved instruction never costs an extra request.
 */
async function fetchArticlePhoto(
  articleUrl: string,
  publisherHost: string,
  rule: SportsPhotoRule | null,
  context: {
    readonly deadline: number;
    readonly signal?: AbortSignal;
    readonly domainLimiter: DomainConcurrencyLimiter;
    readonly now: () => number;
    readonly fetch: SportsSafeFetchPort;
  }
): Promise<string | null> {
  const held = await context.domainLimiter.acquireAll(
    [publisherHost],
    context.deadline,
    context.now,
    context.signal
  );
  if (!held) return null;
  try {
    // Waiting for the slot can itself consume most of what was left, so the deadline margin is
    // checked again here rather than only before the wait.
    if (context.signal?.aborted || context.now() + PHOTO_DEADLINE_MARGIN_MS >= context.deadline) {
      return null;
    }
    const response = await context.fetch(articleUrl, {
      allowedHosts: [publisherHost],
      allowedContentTypes: ARTICLE_PAGE_CONTENT_TYPES,
      maxBytes: MAX_RESPONSE_BYTES,
      rejectOversizedResponses: true,
      timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(1, context.deadline - context.now())),
      signal: context.signal
    });
    if (!response.ok) return null;
    if (rule) {
      const fromRule = applySportsPhotoRule(response.body, response.finalUrl, rule);
      if (fromRule && isUsablePhotoCandidate(fromRule, { publisherHost })) return fromRule;
      if (rule.fallback === "none") return null;
    }
    const found = extractShareImage(response.body, response.finalUrl);
    if (!found) return null;
    return isUsablePhotoCandidate(found.url, { publisherHost }) ? found.url : null;
  } catch {
    return null;
  } finally {
    for (const host of held) context.domainLimiter.release(host);
  }
}
