import { dataContextBrand, type DataContextDb } from "@moss/db";
import { MODULE_DIAGNOSTIC_LIMITS } from "@moss/module-sdk";
import type { NewsFeedProvenance } from "@moss/news";
import { describe, expect, it } from "vitest";

import { createNewsProvenanceDiagnosticsProvider } from "@moss/news";

const scopedDb = { [dataContextBrand]: true } as DataContextDb;
const ctx = { actorUserId: "user-a", requestId: "req-1" };

function provenance(patch: Partial<NewsFeedProvenance> = {}): NewsFeedProvenance {
  return {
    hasSnapshot: true,
    totalStories: 25,
    storiesFromBuiltInSources: 20,
    storiesFromAddedSources: 5,
    storiesFoundByTopicSearch: 0,
    storiesMatchingFollowedTopic: 0,
    storiesFromExcludedSources: 0,
    addedSourceCount: 1,
    followedTopicCount: 0,
    excludedSourceCount: 0,
    ...patch
  };
}

const observe = (value: NewsFeedProvenance) =>
  createNewsProvenanceDiagnosticsProvider({ readFeedProvenance: async () => value }).observe(
    scopedDb,
    ctx
  );

describe("news provenance diagnostics provider", () => {
  it("is a second provider with its own id, in the news domain", () => {
    const provider = createNewsProvenanceDiagnosticsProvider({
      readFeedProvenance: async () => provenance()
    });
    expect(provider.domain).toBe("news");
    expect(provider.providerId).toBe("news.provenance");
  });

  it("reports scalar counts by source kind, topic and exclusion", async () => {
    const result = await observe(
      provenance({ excludedSourceCount: 2, followedTopicCount: 3, storiesMatchingFollowedTopic: 4 })
    );
    expect(result?.facts).toMatchObject({
      totalStories: 25,
      storiesFromBuiltInSources: 20,
      storiesFromAddedSources: 5,
      storiesFoundByTopicSearch: 0,
      storiesMatchingFollowedTopic: 4,
      storiesFromExcludedSources: 0,
      addedSourceCount: 1,
      followedTopicCount: 3,
      excludedSourceCount: 2
    });
  });

  it("states that no topics are followed so a topic match cannot be claimed", async () => {
    const result = await observe(provenance({ followedTopicCount: 0 }));
    expect(result?.summary).toContain("no followed topics");
  });

  it("stays inside the module diagnostic limits and carries only scalars", async () => {
    const result = await observe(provenance());
    expect(Object.keys(result?.facts ?? {}).length).toBeLessThanOrEqual(
      MODULE_DIAGNOSTIC_LIMITS.maxFactKeys
    );
    expect(result!.summary.length).toBeLessThanOrEqual(MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength);
    for (const value of Object.values(result?.facts ?? {})) {
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });

  it("reports unknown when there is no feed yet", async () => {
    const result = await observe(provenance({ hasSnapshot: false, totalStories: 0 }));
    expect(result?.status).toBe("unknown");
  });
});
