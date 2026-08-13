import type { DataContextDb } from "@moss/db";

import type { NewsAiPort, NewsSafeFetchPort, NewsWebSearchPort } from "../discovery/ports.js";
import type { NewsPrefsReader } from "../news-service.js";
import {
  assertSnapshotPayload,
  NEWS_SNAPSHOT_MAX_ARTICLES,
  type NewsSnapshotPayload
} from "../personalization-domain.js";
import type { NewsPersonalizationRepository } from "../personalization-repository.js";
import type { NewsSourceEntry } from "../source/catalog.js";
import { stableIdForUrl } from "../source/rss-source.js";

import { collectCandidates } from "./candidates.js";
import { applyDeterministicFilters } from "./filters.js";
import { orderRanked, rankCandidates, type RankingFailure, type RankedCandidate } from "./rank.js";

const SNAPSHOT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export type NewsCompilationLogFields =
  | {
      readonly event: "news_compile_collection";
      readonly candidateCount: number;
      readonly fetchFailures: number;
      readonly unavailableSources: number;
      readonly durationMs: number;
    }
  | {
      readonly event: "news_compile_result";
      readonly outcome: "replaced" | "kept_last_good" | "stale";
      readonly articleCount: number;
      readonly durationMs: number;
    }
  | {
      readonly event: "news_compile_ai_fallback";
      readonly aiError: RankingFailure;
      readonly candidateCount: number;
    };

export interface MetadataLogger {
  info(fields: NewsCompilationLogFields): void;
  warn?(fields: NewsCompilationLogFields): void;
}

export type CompilationRepository = Pick<
  NewsPersonalizationRepository,
  | "listCustomSources"
  | "listCustomTopics"
  | "listExclusions"
  | "readPolicyVerdict"
  | "upsertPolicyVerdict"
  | "updateSourceHealth"
  | "publishSnapshotIfCurrent"
>;

export async function compilePersonalizedNews(
  scopedDb: DataContextDb,
  deps: {
    fetch: NewsSafeFetchPort;
    search: NewsWebSearchPort;
    ai: NewsAiPort;
    repo: CompilationRepository;
    prefs: NewsPrefsReader;
    catalog: readonly NewsSourceEntry[];
    logger: MetadataLogger;
  },
  opts: { now: Date; generation: number }
): Promise<{
  outcome: "replaced" | "kept_last_good" | "stale";
  failureKind?: "fetch" | "ai" | "internal";
}> {
  const startedAt = Date.now();
  try {
    const collection = await collectCandidates(
      scopedDb,
      {
        fetch: deps.fetch,
        search: deps.search,
        ai: deps.ai,
        repo: deps.repo,
        prefs: deps.prefs,
        catalog: deps.catalog
      },
      { now: opts.now }
    );
    for (const sourceId of collection.sourcesMarkedUnavailable) {
      await deps.repo.updateSourceHealth(scopedDb, sourceId, "unavailable");
    }
    deps.logger.info({
      event: "news_compile_collection",
      candidateCount: collection.candidates.length,
      fetchFailures: collection.fetchFailures,
      unavailableSources: collection.sourcesMarkedUnavailable.length,
      durationMs: Date.now() - startedAt
    });
    if (collection.candidates.length === 0 && collection.fetchFailures > 0) {
      return { outcome: "kept_last_good", failureKind: "fetch" };
    }

    const [exclusions, topics] = await Promise.all([
      deps.repo.listExclusions(scopedDb),
      deps.repo.listCustomTopics(scopedDb)
    ]);
    const filtered = applyDeterministicFilters(collection.candidates, {
      exclusions: exclusions.map((item) => item.canonicalDomain),
      approvedDomains: new Set(collection.candidates.map((item) => item.canonicalDomain)),
      now: opts.now
    });
    const ranking =
      filtered.length === 0
        ? { ok: true as const, ranked: [] }
        : await rankCandidates(
            scopedDb,
            { ai: deps.ai },
            {
              candidates: filtered,
              topics: topics.map((topic) => ({ label: topic.label, guidance: topic.guidance }))
            }
          );
    let ranked: RankedCandidate[];
    if (ranking.ok) {
      ranked = ranking.ranked;
    } else {
      deps.logger.warn?.({
        event: "news_compile_ai_fallback",
        aiError: ranking.error,
        candidateCount: filtered.length
      });
      ranked = orderRanked(
        filtered.map((candidate) => ({
          ...candidate,
          relevance: 0,
          preferredBoost: candidate.origin !== "topic_search"
        }))
      );
    }

    const payload: NewsSnapshotPayload = {
      articles: ranked.slice(0, NEWS_SNAPSHOT_MAX_ARTICLES).map((candidate, index) => ({
        id: stableIdForUrl(candidate.url),
        publisher: candidate.publisher,
        canonicalDomain: candidate.canonicalDomain,
        headline: candidate.headline,
        url: candidate.url,
        publishedAt: candidate.publishedAt,
        excerpt: candidate.excerpt,
        imageUrl: candidate.imageUrl,
        topics: candidate.matchedTopics.slice(0, 3),
        preferred: candidate.preferredBoost,
        rank: index + 1
      }))
    };
    assertSnapshotPayload(payload);
    const published = await deps.repo.publishSnapshotIfCurrent(scopedDb, opts.generation, {
      compiledAt: opts.now,
      expiresAt: new Date(opts.now.getTime() + SNAPSHOT_LIFETIME_MS),
      payload
    });
    const outcome = published ? "replaced" : "stale";
    deps.logger.info({
      event: "news_compile_result",
      outcome,
      articleCount: payload.articles.length,
      durationMs: Date.now() - startedAt
    });
    return { outcome };
  } catch {
    return { outcome: "kept_last_good", failureKind: "internal" };
  }
}
