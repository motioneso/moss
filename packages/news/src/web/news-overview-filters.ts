import type { NewsHeadline, NewsOverviewResponse } from "@moss/shared";

import { CAROUSEL_CAP } from "./news-mosaic.js";
import { isStoryDismissed } from "./dismissed-story-tracker.js";

// A dismissal shrinks the carousel's slide list. Refill it from the stories already loaded in
// the ranked pool so the carousel stays full instead of draining one dismissal at a time — a
// blind refetch here could bring back a stale server snapshot that still has the dismissed story.
function refillTopStories(
  topStories: readonly NewsHeadline[],
  rankedPool: readonly NewsHeadline[] | undefined,
  cap: number
): NewsHeadline[] {
  if (topStories.length >= cap || !rankedPool) return [...topStories];
  const present = new Set(topStories.map((h) => h.id));
  const refilled = [...topStories];
  for (const candidate of rankedPool) {
    if (refilled.length >= cap) break;
    if (present.has(candidate.id)) continue;
    refilled.push(candidate);
    present.add(candidate.id);
  }
  return refilled;
}

/**
 * Removes every story this browser tab has dismissed from an overview answer and refills the
 * carousel from what is left. Used both right after a dismissal is saved and on every later
 * overview answer that reaches the cache, so an answer that was already on its way when the
 * dismissal was saved still comes out with that story gone. See dismissed-story-tracker.ts.
 */
export function withoutDismissedStories(data: NewsOverviewResponse): NewsOverviewResponse {
  const keep = (headline: NewsHeadline) => !isStoryDismissed(headline.feedbackRef);
  const topStories = data.topStories.filter(keep);
  const rankedStories = data.rankedStories?.filter(keep);
  return {
    ...data,
    topStories: refillTopStories(topStories, rankedStories, CAROUSEL_CAP),
    rankedStories,
    sourceGroups: data.sourceGroups
      .map((group) => ({ ...group, headlines: group.headlines.filter(keep) }))
      .filter((group) => group.headlines.length > 0)
  };
}
