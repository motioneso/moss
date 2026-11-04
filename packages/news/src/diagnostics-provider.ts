import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleDiagnosticObservation, ModuleDiagnosticProvider } from "@moss/module-sdk";

import {
  NewsPersonalizationRepository,
  type NewsFeedProvenance,
  type NewsRefreshDiagnostics
} from "./personalization-repository.js";

const STALE_AFTER_SECONDS = 24 * 60 * 60;

function failureDescription(kind: string | null | undefined): string {
  switch (kind) {
    case "fetch":
      return "while fetching news";
    case "ai":
      return "while preparing the feed";
    case "internal":
      return "because of an internal error";
    default:
      return "because of an unknown error";
  }
}

function failureIsNewest(diagnostics: NewsRefreshDiagnostics): boolean {
  const failure = diagnostics.refresh.lastFailureAt;
  if (!failure) return false;
  const success = diagnostics.refresh.lastSuccessAt;
  return !success || failure > success;
}

function statusFor(diagnostics: NewsRefreshDiagnostics): ModuleDiagnosticObservation["status"] {
  if (!diagnostics.refresh.updatedAt && !diagnostics.snapshotCompiledAt) return "unknown";
  if (diagnostics.refresh.state === "failed" || failureIsNewest(diagnostics)) return "failed";
  if (
    !diagnostics.snapshotCompiledAt ||
    (diagnostics.snapshotAgeSeconds ?? 0) > STALE_AFTER_SECONDS ||
    (diagnostics.refresh.state === "idle" &&
      diagnostics.requestedGeneration > diagnostics.compiledGeneration)
  ) {
    return "degraded";
  }
  return "ok";
}

function summaryFor(diagnostics: NewsRefreshDiagnostics): string {
  switch (statusFor(diagnostics)) {
    case "unknown":
      return "News has never been refreshed for this account.";
    case "failed":
      return `News refresh failed ${failureDescription(diagnostics.refresh.lastFailureKind ?? diagnostics.refresh.failureKind)}.`;
    case "degraded":
      return "News is available but its feed is not current.";
    case "ok":
      return "News is current.";
  }
}

function factsFor(
  diagnostics: NewsRefreshDiagnostics
): Readonly<Record<string, string | number | null>> {
  return {
    state: diagnostics.refresh.state,
    failureKind: diagnostics.refresh.failureKind ?? null,
    lastFailureKind: diagnostics.refresh.lastFailureKind,
    lastRequestedAt: diagnostics.refresh.lastRequestedAt,
    lastAttemptAt: diagnostics.refresh.lastAttemptAt,
    lastSuccessAt: diagnostics.refresh.lastSuccessAt,
    lastFailureAt: diagnostics.refresh.lastFailureAt,
    snapshotAgeSeconds: diagnostics.snapshotAgeSeconds,
    itemCount: diagnostics.itemCount,
    requestedGeneration: diagnostics.requestedGeneration,
    compiledGeneration: diagnostics.compiledGeneration
  };
}

export function createNewsDiagnosticsProvider(
  repository: Pick<
    NewsPersonalizationRepository,
    "readRefreshDiagnostics"
  > = new NewsPersonalizationRepository()
): ModuleDiagnosticProvider {
  return {
    domain: "news",
    providerId: "news.refresh",
    async observe(scopedDb: unknown, _ctx) {
      assertDataContextDb(scopedDb);
      const diagnostics = await repository.readRefreshDiagnostics(scopedDb as DataContextDb);
      return {
        domain: "news",
        providerId: "news.refresh",
        observedAt: new Date().toISOString(),
        status: statusFor(diagnostics),
        summary: summaryFor(diagnostics),
        remediationActionId: "news.refreshNews",
        facts: factsFor(diagnostics)
      };
    }
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function provenanceSummary(p: NewsFeedProvenance): string {
  if (!p.hasSnapshot) return "News has no feed yet for this account.";
  const topics =
    p.followedTopicCount === 0
      ? "no followed topics"
      : plural(p.followedTopicCount, "followed topic", "followed topics");
  return (
    `Feed holds ${plural(p.totalStories, "story", "stories")}: ${p.storiesFromBuiltInSources} from ` +
    `built-in sources, ${p.storiesFromAddedSources} from added sources. ` +
    `${topics}, ${plural(p.excludedSourceCount, "excluded source", "excluded sources")}.`
  );
}

/**
 * A second provider because the refresh provider already uses 11 of the 12 allowed fact keys.
 * Counts only: story text, domains and topic labels never appear.
 */
export function createNewsProvenanceDiagnosticsProvider(
  repository: Pick<
    NewsPersonalizationRepository,
    "readFeedProvenance"
  > = new NewsPersonalizationRepository()
): ModuleDiagnosticProvider {
  return {
    domain: "news",
    providerId: "news.provenance",
    async observe(scopedDb: unknown, _ctx) {
      assertDataContextDb(scopedDb);
      const p = await repository.readFeedProvenance(scopedDb as DataContextDb);
      return {
        domain: "news",
        providerId: "news.provenance",
        observedAt: new Date().toISOString(),
        status: p.hasSnapshot ? "ok" : "unknown",
        summary: provenanceSummary(p),
        facts: {
          totalStories: p.totalStories,
          storiesFromBuiltInSources: p.storiesFromBuiltInSources,
          storiesFromAddedSources: p.storiesFromAddedSources,
          storiesFoundByTopicSearch: p.storiesFoundByTopicSearch,
          storiesMatchingFollowedTopic: p.storiesMatchingFollowedTopic,
          storiesFromExcludedSources: p.storiesFromExcludedSources,
          addedSourceCount: p.addedSourceCount,
          followedTopicCount: p.followedTopicCount,
          excludedSourceCount: p.excludedSourceCount
        }
      };
    }
  };
}
