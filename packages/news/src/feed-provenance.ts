import type { NewsCustomSourceDto, NewsCustomTopicDto, NewsPrefDto } from "@moss/shared";

import { assertSnapshotPayload } from "./personalization-domain.js";
import type { NewsSnapshotRecord } from "./personalization-repository.js";
import { resolveEffectivePrefs, visibleSnapshotArticles } from "./news-service.js";
import { topicOption } from "./source/catalog.js";

/**
 * Scalar counts that explain why stories are in the feed. Counts only: no headline, publisher,
 * domain or topic label ever appears here.
 */
export interface NewsFeedProvenance {
  /** "current" means the saved feed is what the reader sees; otherwise News shows a live front page. */
  readonly snapshotState: "none" | "expired" | "current";
  /**
   * Story counts are null when the saved feed is missing or expired, because News then shows a
   * live front page this view does not count. Unknown is never reported as zero.
   */
  /** Stories the reader is shown, after the same filters the feed applies. */
  readonly totalStories: number | null;
  /** Saved stories the feed hides: too old, excluded, repeated or dismissed. */
  readonly storiesHiddenFromSavedFeed: number | null;
  readonly storiesFromBuiltInSources: number | null;
  readonly storiesFromAddedSources: number | null;
  /** Stories found by searching a followed topic, whatever publisher they came from. */
  readonly storiesFoundByTopicSearch: number | null;
  /** Shown stories tagged with a topic the account follows right now. */
  readonly storiesMatchingFollowedTopic: number | null;
  readonly addedSourceCount: number;
  /** Built-in topics plus approved custom topics, the same set the feed uses. */
  readonly followedTopicCount: number;
  readonly excludedSourceCount: number;
  /** False when the "less like this" dismissals could not be consulted. */
  readonly dismissalsApplied: boolean;
}

export interface NewsFeedProvenanceInputs {
  readonly snapshot: NewsSnapshotRecord | null;
  readonly prefs: readonly NewsPrefDto[];
  readonly exclusions: readonly { readonly canonicalDomain: string }[];
  readonly customSources: readonly NewsCustomSourceDto[];
  readonly customTopics: readonly NewsCustomTopicDto[];
  readonly now: Date;
  readonly dismissedRefs: ReadonlySet<string> | null;
  readonly storyRef?: (canonicalUrl: string) => string;
}

export function computeFeedProvenance(input: NewsFeedProvenanceInputs): NewsFeedProvenance {
  const followedLabels = new Set<string>();
  for (const key of resolveEffectivePrefs(input.prefs).topics) {
    const label = topicOption(key)?.label;
    if (label) followedLabels.add(label);
  }
  for (const topic of input.customTopics) {
    if (topic.validationStatus === "approved") followedLabels.add(topic.label);
  }
  const base = {
    storiesHiddenFromSavedFeed: null,
    totalStories: null,
    storiesFromBuiltInSources: null,
    storiesFromAddedSources: null,
    storiesFoundByTopicSearch: null,
    storiesMatchingFollowedTopic: null,
    addedSourceCount: input.customSources.length,
    followedTopicCount: followedLabels.size,
    excludedSourceCount: input.exclusions.length,
    dismissalsApplied: input.dismissedRefs !== null
  };
  if (!input.snapshot) return { ...base, snapshotState: "none" };
  const payload = input.snapshot.payload;
  try {
    assertSnapshotPayload(payload);
  } catch {
    return { ...base, snapshotState: "none" };
  }
  if (input.snapshot.expiresAt.getTime() <= input.now.getTime()) {
    return { ...base, snapshotState: "expired" };
  }

  const visible = visibleSnapshotArticles(
    payload.articles,
    input.exclusions.map((item) => item.canonicalDomain),
    input.now,
    input.dismissedRefs ?? new Set<string>(),
    input.storyRef
  );
  const addedDomains = new Set(input.customSources.map((source) => source.canonicalDomain));
  let builtIn = 0;
  let added = 0;
  let topicSearch = 0;
  let topicMatch = 0;
  for (const article of visible) {
    if (!article.preferred) topicSearch += 1;
    else if (addedDomains.has(article.canonicalDomain)) added += 1;
    else builtIn += 1;
    if (article.topics.some((topic) => followedLabels.has(topic))) topicMatch += 1;
  }
  return {
    ...base,
    snapshotState: "current",
    totalStories: visible.length,
    storiesHiddenFromSavedFeed: payload.articles.length - visible.length,
    storiesFromBuiltInSources: builtIn,
    storiesFromAddedSources: added,
    storiesFoundByTopicSearch: topicSearch,
    storiesMatchingFollowedTopic: topicMatch
  };
}
