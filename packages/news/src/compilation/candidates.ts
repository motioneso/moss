import { Parser } from "htmlparser2";

import type { DataContextDb } from "@moss/db";

import { decideSourcePolicy } from "../discovery/policy-validation.js";
import type { NewsAiPort, NewsSafeFetchPort, NewsWebSearchPort } from "../discovery/ports.js";
import { extractListingHeadlines } from "../discovery/feed-discovery.js";
import { normalizePublisherDomain, publisherDomainMatches } from "../personalization-domain.js";
import type { NewsPersonalizationRepository } from "../personalization-repository.js";
import { resolveEffectivePrefs, type NewsPrefsReader } from "../news-service.js";
import type { NewsSourceEntry } from "../source/catalog.js";
import { topicOption } from "../source/catalog.js";
import { parseFeedXml } from "../source/rss-source.js";
import {
  SUMMARY_CHAR_CAP,
  TITLE_CHAR_CAP,
  sanitizeFeedText,
  sanitizeItemUrl,
  sanitizePublishedAt
} from "../source/sanitize.js";

const PER_SOURCE_CAP = 15;
const COLLECTION_CAP = 300;
const FUTURE_TOLERANCE_MS = 15 * 60 * 1_000;

export interface NewsCandidate {
  readonly id: string;
  readonly publisher: string;
  readonly canonicalDomain: string;
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly excerpt: string | null;
  readonly imageUrl: string | null;
  readonly origin: "preferred_source" | "topic_search" | "curated";
  readonly matchedTopics: readonly string[];
}

type CandidateWithoutId = Omit<NewsCandidate, "id">;

export type NewsSourceFailureReason = "authentication_failed" | "temporarily_unavailable";

export interface NewsCredentialedSourceReader {
  (
    scopedDb: DataContextDb,
    input: { readonly actorUserId: string; readonly sourceId: string }
  ): Promise<
    { readonly items: readonly CredentialedItem[] } | { readonly failure: NewsSourceFailureReason }
  >;
}

export interface CredentialedItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly imageUrl: string | null;
  readonly summary: string;
}

export type CandidateRepository = Pick<
  NewsPersonalizationRepository,
  | "listCustomSources"
  | "listCustomTopics"
  | "listExclusions"
  | "readPolicyVerdict"
  | "upsertPolicyVerdict"
  | "recordWorkaroundRefreshOutcome"
>;

function excluded(domain: string, exclusions: readonly string[]): boolean {
  return exclusions.some((item) => publisherDomainMatches(item, domain));
}

function httpsUrl(raw: string | null | undefined): string | null {
  const url = sanitizeItemUrl(raw);
  return url?.startsWith("https://") ? url : null;
}

function publicationTime(raw: string | null | undefined, now: Date): string | null {
  const iso = sanitizePublishedAt(raw);
  if (!iso) return null;
  return new Date(iso).getTime() <= now.getTime() + FUTURE_TOLERANCE_MS ? iso : null;
}

function articleDomain(url: string): string | null {
  const normalized = normalizePublisherDomain(url);
  return normalized.ok ? normalized.domain : null;
}

function samePublisher(expected: string, actual: string): boolean {
  return publisherDomainMatches(expected, actual) || publisherDomainMatches(actual, expected);
}

function feedCandidates(
  body: string,
  input: {
    publisher: string;
    canonicalDomain: string;
    origin: NewsCandidate["origin"];
    matchedTopics: readonly string[];
    now: Date;
    exclusions: readonly string[];
  }
): CandidateWithoutId[] {
  const candidates: CandidateWithoutId[] = [];
  for (const raw of parseFeedXml(body)) {
    if (candidates.length >= PER_SOURCE_CAP) break;
    const url = httpsUrl(raw.link);
    const domain = url ? articleDomain(url) : null;
    const publishedAt = publicationTime(raw.publishedAt, input.now);
    const headline = sanitizeFeedText(raw.title, TITLE_CHAR_CAP);
    if (
      !url ||
      !domain ||
      !publishedAt ||
      !headline ||
      excluded(domain, input.exclusions) ||
      !samePublisher(input.canonicalDomain, domain)
    ) {
      continue;
    }
    candidates.push({
      publisher: input.publisher,
      canonicalDomain: input.canonicalDomain,
      headline,
      url,
      publishedAt,
      excerpt: sanitizeFeedText(raw.summary || raw.contentFallback, SUMMARY_CHAR_CAP) || null,
      imageUrl: httpsUrl(raw.imageUrl),
      origin: input.origin,
      matchedTopics: input.matchedTopics
    });
  }
  return candidates;
}

function articleMetadata(html: string): {
  publishedAt: string | null;
  excerpt: string | null;
  imageUrl: string | null;
} {
  let publishedAt: string | null = null;
  let excerpt: string | null = null;
  let imageUrl: string | null = null;
  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (tag === "time" && !publishedAt) publishedAt = attributes.datetime ?? null;
      if (tag !== "meta") return;
      const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
      if (["article:published_time", "datepublished", "date"].includes(key)) {
        publishedAt ??= attributes.content ?? null;
      }
      if (key === "description" || key === "og:description") {
        excerpt ??= attributes.content ?? null;
      }
      if (key === "og:image") imageUrl ??= attributes.content ?? null;
    }
  });
  parser.end(html);
  return { publishedAt, excerpt, imageUrl };
}

async function collectCustomSource(
  scopedDb: DataContextDb,
  source: Awaited<ReturnType<NewsPersonalizationRepository["listCustomSources"]>>[number],
  deps: {
    fetch: NewsSafeFetchPort;
    credentialedSource?: NewsCredentialedSourceReader;
  },
  input: { now: Date; exclusions: readonly string[]; actorUserId?: string; credentialed: boolean }
): Promise<{ candidates: CandidateWithoutId[]; failure: NewsSourceFailureReason | null }> {
  if (input.credentialed) {
    if (!input.actorUserId || !deps.credentialedSource) {
      return { candidates: [], failure: "authentication_failed" };
    }
    const result = await deps.credentialedSource(scopedDb, {
      actorUserId: input.actorUserId,
      sourceId: source.id
    });
    if ("failure" in result) return { candidates: [], failure: result.failure };
    return {
      candidates: result.items.flatMap((item) => {
        const url = httpsUrl(item.url);
        const domain = url ? articleDomain(url) : null;
        const publishedAt = publicationTime(item.publishedAt, input.now);
        if (!url || !domain || !publishedAt || excluded(domain, input.exclusions)) {
          return [];
        }
        return [
          {
            publisher: source.label,
            canonicalDomain: source.canonicalDomain,
            headline: sanitizeFeedText(item.title, TITLE_CHAR_CAP),
            url,
            publishedAt,
            excerpt: sanitizeFeedText(item.summary, SUMMARY_CHAR_CAP) || null,
            imageUrl: httpsUrl(item.imageUrl),
            origin: "preferred_source" as const,
            matchedTopics: []
          }
        ];
      }),
      failure: null
    };
  }

  const target = source.feedUrl ?? source.homepageUrl;
  const response = await deps.fetch(target);
  if (!response.ok) return { candidates: [], failure: "temporarily_unavailable" };
  const finalDomain = articleDomain(response.finalUrl);
  if (!finalDomain || excluded(finalDomain, input.exclusions)) {
    return { candidates: [], failure: "temporarily_unavailable" };
  }
  if (source.feedUrl) {
    if (!samePublisher(source.canonicalDomain, finalDomain)) {
      return { candidates: [], failure: "temporarily_unavailable" };
    }
    return {
      candidates: feedCandidates(response.body, {
        publisher: source.label,
        canonicalDomain: source.canonicalDomain,
        origin: "preferred_source",
        matchedTopics: [],
        ...input
      }),
      failure: null
    };
  }

  const candidates: CandidateWithoutId[] = [];
  for (const item of extractListingHeadlines(response.body, response.finalUrl, PER_SOURCE_CAP)) {
    const domain = articleDomain(item.url);
    if (
      !domain ||
      excluded(domain, input.exclusions) ||
      !samePublisher(source.canonicalDomain, domain)
    ) {
      continue;
    }
    const article = await deps.fetch(item.url);
    if (!article.ok) continue;
    const finalArticleDomain = articleDomain(article.finalUrl);
    if (
      !finalArticleDomain ||
      excluded(finalArticleDomain, input.exclusions) ||
      !samePublisher(source.canonicalDomain, finalArticleDomain)
    ) {
      continue;
    }
    const metadata = articleMetadata(article.body);
    const publishedAt = publicationTime(metadata.publishedAt, input.now);
    if (!publishedAt) continue;
    candidates.push({
      publisher: source.label,
      canonicalDomain: source.canonicalDomain,
      headline: sanitizeFeedText(item.headline, TITLE_CHAR_CAP),
      url: article.finalUrl,
      publishedAt,
      excerpt: sanitizeFeedText(metadata.excerpt, SUMMARY_CHAR_CAP) || null,
      imageUrl: httpsUrl(metadata.imageUrl),
      origin: "preferred_source",
      matchedTopics: []
    });
  }
  return { candidates, failure: null };
}

export async function collectCandidates(
  scopedDb: DataContextDb,
  deps: {
    fetch: NewsSafeFetchPort;
    search: NewsWebSearchPort;
    ai: NewsAiPort;
    repo: CandidateRepository;
    prefs: NewsPrefsReader;
    catalog: readonly NewsSourceEntry[];
    credentials?: {
      readStatuses(scopedDb: DataContextDb): Promise<readonly { sourceId: string }[]>;
    };
    credentialedSource?: NewsCredentialedSourceReader;
  },
  opts: { now: Date; actorUserId?: string }
): Promise<{
  candidates: NewsCandidate[];
  fetchFailures: number;
  sourcesMarkedUnavailable: string[];
  sourceFailures: readonly { sourceId: string; reason: NewsSourceFailureReason }[];
}> {
  const [sources, topics, exclusionRows, prefs] = await Promise.all([
    deps.repo.listCustomSources(scopedDb),
    deps.repo.listCustomTopics(scopedDb),
    deps.repo.listExclusions(scopedDb),
    deps.prefs.list(scopedDb)
  ]);
  const exclusions = exclusionRows.map((item) => item.canonicalDomain);
  const collected: CandidateWithoutId[] = [];
  let fetchFailures = 0;
  const sourcesMarkedUnavailable: string[] = [];
  const sourceFailures: { sourceId: string; reason: NewsSourceFailureReason }[] = [];
  const credentialedSourceIds = new Set(
    (deps.credentials ? await deps.credentials.readStatuses(scopedDb) : []).map(
      (credential) => credential.sourceId
    )
  );

  for (const source of sources) {
    if (
      source.validationStatus !== "approved" ||
      source.healthStatus !== "healthy" ||
      excluded(source.canonicalDomain, exclusions)
    ) {
      continue;
    }
    const result = await collectCustomSource(scopedDb, source, deps, {
      now: opts.now,
      exclusions,
      actorUserId: opts.actorUserId,
      credentialed: credentialedSourceIds.has(source.id)
    });
    collected.push(...result.candidates);
    if (result.failure) {
      fetchFailures += 1;
      sourceFailures.push({ sourceId: source.id, reason: result.failure });
      if (result.failure === "temporarily_unavailable") sourcesMarkedUnavailable.push(source.id);
    }
  }

  const effective = resolveEffectivePrefs(prefs);
  const catalogByKey = new Map(deps.catalog.map((source) => [source.sourceKey, source]));
  for (const selected of effective.sources) {
    const source = catalogByKey.get(selected.sourceKey);
    if (!source) continue;
    const canonical = normalizePublisherDomain(source.homepageUrl);
    if (!canonical.ok || excluded(canonical.domain, exclusions)) continue;
    const plans =
      effective.topics.length === 0
        ? [{ url: source.topFeedUrl, topics: [] as string[] }]
        : effective.topics.flatMap((key) => {
            const url = source.topicFeeds[key];
            const label = topicOption(key)?.label;
            return url && label ? [{ url, topics: [label] }] : [];
          });
    const sourceItems: CandidateWithoutId[] = [];
    for (const plan of plans) {
      if (sourceItems.length >= PER_SOURCE_CAP) break;
      const response = await deps.fetch(plan.url);
      if (!response.ok) {
        fetchFailures += 1;
        continue;
      }
      sourceItems.push(
        ...feedCandidates(response.body, {
          publisher: source.label,
          canonicalDomain: canonical.domain,
          origin: "curated",
          matchedTopics: plan.topics,
          now: opts.now,
          exclusions
        }).slice(0, PER_SOURCE_CAP - sourceItems.length)
      );
    }
    collected.push(...sourceItems);
  }

  for (const topic of topics) {
    if (topic.validationStatus !== "approved") continue;
    let results;
    try {
      results = await deps.search.search(
        scopedDb,
        [topic.label, topic.guidance].filter(Boolean).join(" — "),
        { limit: 5, freshness: "week" }
      );
    } catch {
      fetchFailures += 1;
      continue;
    }
    for (const result of results.results.slice(0, 5)) {
      const url = httpsUrl(result.url);
      const domain = url ? articleDomain(url) : null;
      const headline = sanitizeFeedText(result.title, TITLE_CHAR_CAP);
      if (!url || !domain || !headline || excluded(domain, exclusions)) continue;
      const policy = await decideSourcePolicy(
        scopedDb,
        { ai: deps.ai, repo: deps.repo },
        {
          canonicalDomain: domain,
          description: result.snippet,
          sampleHeadlines: [headline]
        }
      );
      if (policy.verdict !== "approved") continue;

      let articleUrl = url;
      let publishedAt = publicationTime(result.publishedAt, opts.now);
      let excerpt = sanitizeFeedText(result.snippet, SUMMARY_CHAR_CAP) || null;
      let imageUrl: string | null = null;
      const article = await deps.fetch(url);
      if (article.ok) {
        const finalDomain = articleDomain(article.finalUrl);
        if (
          !finalDomain ||
          excluded(finalDomain, exclusions) ||
          !samePublisher(domain, finalDomain)
        ) {
          continue;
        }
        const metadata = articleMetadata(article.body);
        articleUrl = article.finalUrl;
        publishedAt ??= publicationTime(metadata.publishedAt, opts.now);
        excerpt ??= sanitizeFeedText(metadata.excerpt, SUMMARY_CHAR_CAP) || null;
        imageUrl = httpsUrl(metadata.imageUrl);
      }
      if (!publishedAt) continue;
      collected.push({
        publisher: domain,
        canonicalDomain: domain,
        headline,
        url: articleUrl,
        publishedAt,
        excerpt,
        imageUrl,
        origin: "topic_search",
        matchedTopics: [topic.label]
      });
    }
  }

  return {
    candidates: collected.slice(0, COLLECTION_CAP).map((candidate, index) => ({
      id: `c${index + 1}`,
      ...candidate
    })),
    fetchFailures,
    sourcesMarkedUnavailable: [...new Set(sourcesMarkedUnavailable)],
    sourceFailures
  };
}
