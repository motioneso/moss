import type { DataContextDb } from "@moss/db";
import type { StoryRelevanceCandidate, StoryRelevanceFailure } from "@moss/shared";

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
import type { NewsStoryFeedbackPort } from "../story-feedback-port.js";

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
    }
  /**
   * #2018: counts and failure class only. Never a reason, a headline, a link or a story
   * reference - the owner's own words have exactly one home and this is not it.
   */
  | {
      readonly event: "news_compile_relevance_degraded";
      readonly failure: StoryRelevanceFailure;
      readonly excludedCount: number;
      readonly candidateCount: number;
      readonly keptCount: number;
      readonly durationMs: number;
    }
  | {
      readonly event: "news_compile_relevance_applied";
      readonly candidateCount: number;
      readonly keptCount: number;
      readonly boostedCount: number;
      readonly durationMs: number;
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
    /**
     * #2018: story usefulness feedback. Optional: when it is absent the relevance step is skipped
     * entirely and compilation behaves exactly as it did before, which is what every setup that
     * composes News without the feedback module needs.
     */
    storyFeedback?: NewsStoryFeedbackPort;
  },
  opts: { now: Date; generation: number; ownerUserId?: string }
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
    // #2018: the owner's saved story preferences decide what survives, BEFORE anything is ranked
    // or published. Placing it here means a suppressed story never reaches a snapshot at all,
    // rather than being hidden on the way out where a second reader could still find it.
    let selected = filtered;
    const boosts = new Map<string, number>();
    const storyRefs = new Map<string, string>();
    const port = deps.storyFeedback;
    if (port && opts.ownerUserId && filtered.length > 0) {
      for (const candidate of filtered) {
        const ref = safeStoryRef(candidate.url, port);
        if (ref !== null) storyRefs.set(candidate.url, ref);
      }
      const relevanceStartedAt = Date.now();
      const leadDomains = new Set<string>();
      const relevance = await port.applyRelevance(scopedDb, {
        ownerUserId: opts.ownerUserId,
        candidates: filtered.flatMap((candidate, index) => {
          const ref = storyRefs.get(candidate.url);
          // A story whose link cannot be turned into a reference is never shown to the relevance
          // layer, and is never suppressed by it either. It simply carries on unjudged.
          const leadsPublisher = !leadDomains.has(candidate.canonicalDomain);
          leadDomains.add(candidate.canonicalDomain);
          return ref === undefined
            ? []
            : [toRelevanceCandidate(candidate, ref, index, leadsPublisher)];
        }),
        now: opts.now
      });
      if (relevance.status === "degraded") {
        // A half-filtered page is worse than a stale one: publish nothing, keep the last good
        // snapshot, and record the run as failed so the existing retry machinery sees it.
        deps.logger.warn?.({
          event: "news_compile_relevance_degraded",
          failure: relevance.failure,
          excludedCount: relevance.excludedRefs.length,
          candidateCount: filtered.length,
          keptCount: relevance.kept.length,
          durationMs: Date.now() - relevanceStartedAt
        });
        return { outcome: "kept_last_good", failureKind: "ai" };
      }
      const keptRefs = new Set(relevance.kept.map((candidate) => candidate.storyRef));
      selected = filtered.filter((candidate) => {
        const ref = storyRefs.get(candidate.url);
        return ref === undefined || keptRefs.has(ref);
      });
      for (const boost of relevance.boosts) boosts.set(boost.storyRef, boost.lift);
      deps.logger.info({
        event: "news_compile_relevance_applied",
        candidateCount: filtered.length,
        keptCount: selected.length,
        boostedCount: relevance.boosts.length,
        durationMs: Date.now() - relevanceStartedAt
      });
    }

    const ranking =
      selected.length === 0
        ? { ok: true as const, ranked: [] }
        : await rankCandidates(
            scopedDb,
            { ai: deps.ai },
            {
              candidates: selected,
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
        // The fallback re-ranks the SELECTED list, not the filtered one. Re-ranking `filtered`
        // here would quietly put every suppressed story back on the page.
        candidateCount: selected.length
      });
      ranked = orderRanked(
        selected.map((candidate) => ({
          ...candidate,
          relevance: 0,
          preferredBoost: candidate.origin !== "topic_search"
        }))
      );
    }

    // A "more like this" preference is a bounded nudge, not a takeover: the lift is added to the
    // relevance score and the existing sort applies, so it can never defeat deduplication or fill
    // the page on its own.
    if (boosts.size > 0) {
      ranked = orderRanked(
        ranked.map((candidate) => {
          const ref = storyRefs.get(candidate.url);
          const lift = ref === undefined ? 0 : (boosts.get(ref) ?? 0);
          return lift === 0 ? candidate : { ...candidate, relevance: candidate.relevance + lift };
        })
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

/**
 * The only description of a story the relevance layer ever sees. Article bodies are never part of
 * it, and neither is the link.
 */
function toRelevanceCandidate(
  candidate: {
    readonly headline: string;
    readonly publisher: string;
    readonly publishedAt: string;
    readonly matchedTopics: readonly string[];
  },
  storyRef: string,
  feedPosition: number,
  leadsPublisher: boolean
): StoryRelevanceCandidate {
  return {
    storyRef,
    headline: candidate.headline,
    sourceLabel: candidate.publisher,
    publishedAt: candidate.publishedAt,
    feedPosition,
    topicRef: candidate.matchedTopics[0] ?? null,
    editorialEvidence: leadsPublisher ? ["source_lead_position"] : []
    // News has no opinion flag on a candidate, so `isOpinion` is deliberately left unset rather
    // than guessed.
  };
}

/** A malformed link throws rather than minting a reference; one bad row must not fail the run. */
function safeStoryRef(url: string, port: NewsStoryFeedbackPort): string | null {
  try {
    return port.storyRef(url);
  } catch {
    return null;
  }
}
