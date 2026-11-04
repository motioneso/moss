import { assertDataContextDb, withSavepoint, type DataContextDb } from "@moss/db";
import type { ModuleDiagnosticObservation, ModuleDiagnosticProvider } from "@moss/module-sdk";

import { computeFeedProvenance, type NewsFeedProvenance } from "./feed-provenance.js";
import {
  NewsPersonalizationRepository,
  type NewsRefreshDiagnostics
} from "./personalization-repository.js";
import { NewsPrefsRepository } from "./repository.js";
import type { NewsStoryFeedbackPort } from "./story-feedback-port.js";

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
  if (p.snapshotState === "none") return "News has no saved feed yet for this account.";
  const topics =
    p.followedTopicCount === 0
      ? "no followed topics"
      : plural(p.followedTopicCount, "followed topic", "followed topics");
  const tail = `${topics}, ${plural(p.excludedSourceCount, "excluded source", "excluded sources")}.`;
  if (p.snapshotState === "expired") {
    return `The saved feed has expired, so News shows a live front page from built-in sources. ${tail}`;
  }
  return (
    `The feed shows ${plural(p.totalStories, "story", "stories")}: ${p.storiesFromBuiltInSources} ` +
    `from built-in sources, ${p.storiesFromAddedSources} from added sources, ` +
    `${p.storiesFoundByTopicSearch} found by a topic search. ${tail}`
  );
}

/**
 * Dismissals live in another module, so the composition root hands this module its story
 * feedback port after startup. Until then the counts skip dismissals and say so.
 */
let storyFeedbackPort: NewsStoryFeedbackPort | undefined;

export function setNewsDiagnosticsStoryFeedback(port: NewsStoryFeedbackPort | undefined): void {
  storyFeedbackPort = port;
}

export interface NewsProvenanceDependencies {
  readonly personalization: Pick<
    NewsPersonalizationRepository,
    "readLatestSnapshot" | "listExclusions" | "listCustomSources" | "listCustomTopics"
  >;
  readonly prefs: Pick<NewsPrefsRepository, "list">;
  readonly now?: () => Date;
  readonly storyFeedback?: () => NewsStoryFeedbackPort | undefined;
}

/**
 * A second provider because the refresh provider already uses 11 of the 12 allowed fact keys.
 * Counts come from the same filters the feed uses (visibleSnapshotArticles). Story text, domains
 * and topic labels never appear.
 */
export function createNewsProvenanceDiagnosticsProvider(
  deps: NewsProvenanceDependencies = {
    personalization: new NewsPersonalizationRepository(),
    prefs: new NewsPrefsRepository()
  }
): ModuleDiagnosticProvider {
  return {
    domain: "news",
    providerId: "news.provenance",
    async observe(scopedDb: unknown, ctx) {
      assertDataContextDb(scopedDb);
      const db = scopedDb as DataContextDb;
      const port = (deps.storyFeedback ?? (() => storyFeedbackPort))();
      const [prefs, exclusions, customSources, customTopics, snapshot] = await Promise.all([
        deps.prefs.list(db),
        deps.personalization.listExclusions(db),
        deps.personalization.listCustomSources(db),
        deps.personalization.listCustomTopics(db),
        deps.personalization.readLatestSnapshot(db)
      ]);
      let dismissedRefs: ReadonlySet<string> | null = null;
      if (port) {
        dismissedRefs = await withSavepoint(db, () =>
          port.listDismissedRefs(db, ctx.actorUserId)
        ).catch(() => null);
      }
      const p = computeFeedProvenance({
        snapshot,
        prefs,
        exclusions,
        customSources,
        customTopics,
        now: (deps.now ?? (() => new Date()))(),
        dismissedRefs,
        ...(port ? { storyRef: port.storyRef.bind(port) } : {})
      });
      return {
        domain: "news",
        providerId: "news.provenance",
        observedAt: new Date().toISOString(),
        status:
          p.snapshotState === "current"
            ? "ok"
            : p.snapshotState === "expired"
              ? "degraded"
              : "unknown",
        summary: provenanceSummary(p),
        facts: {
          totalStories: p.totalStories,
          storiesHiddenFromSavedFeed: p.storiesHiddenFromSavedFeed,
          storiesFromBuiltInSources: p.storiesFromBuiltInSources,
          storiesFromAddedSources: p.storiesFromAddedSources,
          storiesFoundByTopicSearch: p.storiesFoundByTopicSearch,
          storiesMatchingFollowedTopic: p.storiesMatchingFollowedTopic,
          addedSourceCount: p.addedSourceCount,
          followedTopicCount: p.followedTopicCount,
          excludedSourceCount: p.excludedSourceCount,
          dismissalsApplied: p.dismissalsApplied
        }
      };
    }
  };
}
