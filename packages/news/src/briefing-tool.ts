import type { DatasetClient } from "@moss/datasets";
import { assertDataContextDb } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  capHeartbeatItems,
  heartbeatRevision,
  parseHeartbeatSourceReadInput,
  type HeartbeatEvidenceItem,
  type HeartbeatSourceRead
} from "@moss/shared";

import { NewsPrefsRepository } from "./repository.js";
import { NewsService } from "./news-service.js";
import { NewsPersonalizationRepository } from "./personalization-repository.js";
import type { NewsStoryFeedbackPort } from "./story-feedback-port.js";

/**
 * Sole intended consumer is the daily briefing (mirrors sports' followedFactsToday). It is
 * mechanically visible to the chat tool-registry because the platform has no briefing-only flag
 * today; its output is capped at 5 compact "Title — Source" lines, never the full page payload.
 *
 * The service reads prefs directly from the gateway-scoped db passed to `execute`; the
 * `dataContext` runner seam is unused on this path, so a throwing stub satisfies the type
 * without ever opening a second, unscoped connection.
 *
 * The service needs a `DatasetClient`, which the composition root only has once it has built the
 * news module's `newsfeeds` external source (packages/module-registry/src/index.ts). This tool
 * is registered as static manifest data (`./manifest.ts`) constructed at import time, before that
 * wiring runs — so construction is deferred to `configureNewsBriefingService`, which the registry
 * calls once, synchronously, during boot, strictly before any request can reach
 * `newsTopHeadlinesTodayExecute`.
 */
let service: NewsService | undefined;

export function configureNewsBriefingService(
  datasetClient: DatasetClient,
  storyFeedback?: NewsStoryFeedbackPort
): void {
  service = new NewsService({
    datasetClient,
    dataContext: {
      withDataContext() {
        throw new Error("news briefing tool reads the gateway-scoped db directly");
      }
    },
    repository: new NewsPrefsRepository(),
    // #953: briefing headlines honor the actor's publisher-domain exclusions too.
    personalization: new NewsPersonalizationRepository(),
    // #3227: dismissed stories stay out of the briefing.
    storyFeedback
  });
}

export const newsTopHeadlinesTodayExecute: ToolExecute = async (
  scopedDb,
  _input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  if (!service) {
    throw new Error(
      "news briefing tool used before configureNewsBriefingService ran (composition-root bug)"
    );
  }
  const { facts, evidence } = await service.getTopHeadlinesForToday(scopedDb, ctx.actorUserId);
  return { data: { facts, evidence } };
};

/**
 * Input must stay inside the read contract. Extra keys (an owner or user id) are refused, and the
 * reads below run as the actor the data context was opened for.
 */
export async function authorizeNewsHeartbeatRead(
  _scopedDb: DataContextDb,
  input: Record<string, unknown>
): Promise<boolean> {
  return parseHeartbeatSourceReadInput(input) !== null;
}

/** Top stories from the published snapshot. Never contacts a news source. */
export const newsHeartbeatHeadlinesExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const parsed = parseHeartbeatSourceReadInput(input);
  if (!parsed) throw new Error("Invalid heartbeat read input");
  if (!service) {
    throw new Error(
      "news briefing tool used before configureNewsBriefingService ran (composition-root bug)"
    );
  }
  const { stories, freshness } = await service.getCachedHeadlinesForHeartbeat(
    scopedDb,
    ctx.actorUserId
  );
  const { items: bounded, truncated } = capHeartbeatItems(stories, parsed.limit);
  const items: HeartbeatEvidenceItem[] = bounded.map((story) => ({
    entityKey: `story:${story.id}`,
    episodeKey: `story:${story.id}`,
    title: story.title,
    at: story.publishedAt,
    kind: "headline",
    facts: { source: story.sourceLabel, summary: story.summary }
  }));
  const data: HeartbeatSourceRead = {
    source: "news",
    revision: heartbeatRevision(stories.map((story) => [story.id, story.title].join("|"))),
    nextBoundaryAt: null,
    freshness,
    truncated,
    items
  };
  return { data };
};
