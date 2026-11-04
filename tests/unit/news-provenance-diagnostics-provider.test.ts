import { dataContextBrand, type DataContextDb } from "@moss/db";
import { sanitizeAssistantToolResult } from "@moss/ai";
import { MODULE_DIAGNOSTIC_LIMITS } from "@moss/module-sdk";
import {
  computeFeedProvenance,
  createNewsProvenanceDiagnosticsProvider,
  type NewsFeedProvenanceInputs
} from "@moss/news";
import { platformDiagnosticsOutputSchema } from "@moss/settings";
import { describe, expect, it, vi } from "vitest";

// The unit test has no database, so the savepoint wrapper just runs the work.
vi.mock("@moss/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withSavepoint: async (_db: unknown, work: () => Promise<unknown>) => work()
}));

const scopedDb = { [dataContextBrand]: true } as DataContextDb;
const ctx = { actorUserId: "user-a", requestId: "req-1" };
const NOW = new Date("2026-11-04T12:00:00.000Z");

function story(id: string, domain: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    publisher: "P",
    canonicalDomain: domain,
    headline: "h",
    url: `https://${domain}/${id}`,
    publishedAt: "2026-11-04T10:00:00.000Z",
    excerpt: "e",
    imageUrl: null,
    topics: [] as string[],
    preferred: true,
    rank: 1,
    ...patch
  };
}

function inputs(
  articles: ReturnType<typeof story>[],
  patch: Partial<NewsFeedProvenanceInputs> = {}
): NewsFeedProvenanceInputs {
  return {
    snapshot: {
      compiledAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      payload: { articles }
    },
    prefs: [],
    exclusions: [],
    customSources: [],
    customTopics: [],
    now: NOW,
    dismissedRefs: new Set<string>(),
    ...patch
  };
}

const topicPref = (key: string) => ({ id: key, kind: "topic" as const, key, createdAt: "x" });
const customTopic = (label: string, validationStatus: string) =>
  ({ id: label, label, validationStatus }) as never;

describe("computeFeedProvenance", () => {
  it("counts only stories the feed would show", () => {
    const p = computeFeedProvenance(
      inputs(
        [
          story("1", "keep.example.org"),
          story("2", "gone.example.org"),
          story("3", "keep.example.org", { url: "https://keep.example.org/1" }),
          story("4", "old.example.org", { publishedAt: "2026-10-01T00:00:00.000Z" }),
          story("5", "dismissed.example.org")
        ],
        {
          exclusions: [{ canonicalDomain: "gone.example.org" }],
          dismissedRefs: new Set(["ref:https://dismissed.example.org/5"]),
          storyRef: (url) => `ref:${url}`
        }
      )
    );
    expect(p.totalStories).toBe(1);
    expect(p.storiesHiddenFromSavedFeed).toBe(4);
  });

  it("counts built-in topics as followed and ignores unapproved custom topics", () => {
    const p = computeFeedProvenance(
      inputs([story("1", "a.example.org", { topics: ["Technology"] })], {
        prefs: [topicPref("technology")],
        customTopics: [
          customTopic("Pending", "needs_revalidation"),
          customTopic("Mine", "approved")
        ]
      })
    );
    expect(p.followedTopicCount).toBe(2);
    expect(p.storiesMatchingFollowedTopic).toBe(1);
  });

  it("does not match a stale topic tag after the topic is unfollowed", () => {
    const p = computeFeedProvenance(
      inputs([story("1", "a.example.org", { topics: ["Technology"] })], { prefs: [] })
    );
    expect(p.followedTopicCount).toBe(0);
    expect(p.storiesMatchingFollowedTopic).toBe(0);
  });

  it("keeps topic-search stories out of the built-in count", () => {
    const p = computeFeedProvenance(
      inputs(
        [
          story("1", "a.example.org"),
          story("2", "random.example.net", { preferred: false }),
          story("3", "added.example.com")
        ],
        { customSources: [{ canonicalDomain: "added.example.com" } as never] }
      )
    );
    expect(p).toMatchObject({
      storiesFromBuiltInSources: 1,
      storiesFoundByTopicSearch: 1,
      storiesFromAddedSources: 1
    });
  });

  it("reports an expired feed without counting its stories", () => {
    const p = computeFeedProvenance(
      inputs([story("1", "a.example.org")], {
        snapshot: {
          compiledAt: NOW,
          expiresAt: new Date(NOW.getTime() - 1000),
          payload: { articles: [story("1", "a.example.org")] }
        }
      })
    );
    expect(p.snapshotState).toBe("expired");
    expect(p.totalStories).toBeNull();
    expect(p.storiesFromBuiltInSources).toBeNull();
  });

  it("flags that dismissals were not consulted", () => {
    expect(computeFeedProvenance(inputs([], { dismissedRefs: null })).dismissalsApplied).toBe(
      false
    );
  });
});

const noDismissals = () =>
  ({
    storyRef: (url: string) => `ref:${url}`,
    listDismissedRefs: async () => new Set<string>()
  }) as never;

function provider(input: NewsFeedProvenanceInputs, storyFeedback: () => unknown = noDismissals) {
  return createNewsProvenanceDiagnosticsProvider({
    personalization: {
      readLatestSnapshot: async () => input.snapshot,
      listExclusions: async () => input.exclusions as never,
      listCustomSources: async () => [...input.customSources],
      listCustomTopics: async () => [...input.customTopics]
    },
    prefs: { list: async () => [...input.prefs] },
    now: () => NOW,
    storyFeedback: storyFeedback as never
  });
}

describe("news provenance diagnostics provider", () => {
  it("is a second provider with its own id, in the news domain", () => {
    const p = provider(inputs([]));
    expect(p.domain).toBe("news");
    expect(p.providerId).toBe("news.provenance");
  });

  it("reports scalar counts inside the diagnostic limits", async () => {
    const result = await provider(
      inputs([story("1", "a.example.org"), story("2", "b.example.net", { preferred: false })])
    ).observe(scopedDb, ctx);
    expect(result?.status).toBe("ok");
    expect(result?.facts).toMatchObject({
      totalStories: 2,
      storiesFromBuiltInSources: 1,
      storiesFoundByTopicSearch: 1,
      dismissalsApplied: true
    });
    expect(Object.keys(result?.facts ?? {}).length).toBeLessThanOrEqual(
      MODULE_DIAGNOSTIC_LIMITS.maxFactKeys
    );
    expect(result!.summary.length).toBeLessThanOrEqual(MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength);
    for (const value of Object.values(result?.facts ?? {})) {
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });

  it("states that no topics are followed", async () => {
    const result = await provider(inputs([story("1", "a.example.org")])).observe(scopedDb, ctx);
    expect(result?.summary).toContain("no followed topics");
  });

  it("reports unknown when there is no feed yet", async () => {
    const result = await provider(inputs([], { snapshot: null })).observe(scopedDb, ctx);
    expect(result?.status).toBe("unknown");
    for (const key of STORY_COUNT_KEYS) expect(result?.facts?.[key]).toBeNull();
  });

  it("is degraded and qualifies the counts when no dismissal source is available", async () => {
    const result = await provider(inputs([story("1", "a.example.org")]), () => undefined).observe(
      scopedDb,
      ctx
    );
    expect(result?.status).toBe("degraded");
    expect(result?.facts).toMatchObject({ dismissalsApplied: false });
    expect(result?.summary).toContain("may include dismissed stories");
    expect(result!.summary.length).toBeLessThanOrEqual(MODULE_DIAGNOSTIC_LIMITS.summaryMaxLength);
  });

  it("is degraded and qualifies the counts when the dismissal lookup fails", async () => {
    const failing = () =>
      ({
        storyRef: (url: string) => url,
        listDismissedRefs: async () => {
          throw new Error("down");
        }
      }) as never;
    const result = await provider(inputs([story("1", "a.example.org")]), failing).observe(
      scopedDb,
      ctx
    );
    expect(result?.status).toBe("degraded");
    expect(result?.summary).toContain("may include dismissed stories");
  });

  it("reports unknown counts, not zero, when the saved feed has expired", async () => {
    const expired = inputs([], {
      snapshot: {
        compiledAt: NOW,
        expiresAt: new Date(NOW.getTime() - 1000),
        payload: { articles: [story("1", "a.example.org")] }
      }
    });
    const result = await provider(expired).observe(scopedDb, ctx);
    expect(result?.status).toBe("degraded");
    for (const key of STORY_COUNT_KEYS) expect(result?.facts?.[key]).toBeNull();
    expect(result?.summary).toContain("unknown");
  });
});

const STORY_COUNT_KEYS = [
  "totalStories",
  "storiesHiddenFromSavedFeed",
  "storiesFromBuiltInSources",
  "storiesFromAddedSources",
  "storiesFoundByTopicSearch",
  "storiesMatchingFollowedTopic"
] as const;

/** Runs the provider's observation through the same output filter the tool uses. */
async function throughToolOutput(input: NewsFeedProvenanceInputs, feedback?: () => unknown) {
  const observation = await provider(input, feedback).observe(scopedDb, ctx);
  const sanitized = sanitizeAssistantToolResult(platformDiagnosticsOutputSchema, {
    data: {
      observedAt: "2026-11-04T12:00:00.000Z",
      build: { version: "v", buildId: "b" },
      runtime: null,
      modules: [observation],
      errors: [],
      actions: [],
      jobs: { recent: [], summaries: [], truncated: false },
      connections: { items: [], truncated: false },
      source: null,
      redactions: []
    }
  });
  return (sanitized.data.modules as { facts: Record<string, unknown> }[])[0]!.facts;
}

describe("news provenance facts through the tool output filter", () => {
  it("keeps every count and the dismissal result for a current feed", async () => {
    const facts = await throughToolOutput(
      inputs([story("1", "a.example.org"), story("2", "b.example.net", { preferred: false })])
    );
    expect(facts).toMatchObject({
      totalStories: 2,
      storiesHiddenFromSavedFeed: 0,
      storiesFromBuiltInSources: 1,
      storiesFromAddedSources: 0,
      storiesFoundByTopicSearch: 1,
      storiesMatchingFollowedTopic: 0,
      addedSourceCount: 0,
      followedTopicCount: 0,
      excludedSourceCount: 0,
      dismissalsApplied: true
    });
  });

  it("keeps all six story counts as null for an expired feed", async () => {
    const facts = await throughToolOutput(
      inputs([], {
        snapshot: {
          compiledAt: NOW,
          expiresAt: new Date(NOW.getTime() - 1000),
          payload: { articles: [story("1", "a.example.org")] }
        }
      })
    );
    for (const key of STORY_COUNT_KEYS) expect(facts[key]).toBeNull();
    expect(facts).toMatchObject({ dismissalsApplied: true });
  });

  it("keeps all six story counts as null for a missing feed", async () => {
    const facts = await throughToolOutput(inputs([], { snapshot: null }));
    for (const key of STORY_COUNT_KEYS) expect(facts[key]).toBeNull();
    expect(facts).toMatchObject({ addedSourceCount: 0, excludedSourceCount: 0 });
  });

  it("keeps the dismissal-check result when dismissals were not applied", async () => {
    const facts = await throughToolOutput(inputs([story("1", "a.example.org")]), () => undefined);
    expect(facts).toMatchObject({ dismissalsApplied: false, totalStories: 1 });
  });
});
