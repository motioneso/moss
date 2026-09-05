import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";

import type { StoryRelevanceCandidate, StoryRelevanceResult } from "@moss/shared";

import { compilePersonalizedNews } from "../../packages/news/src/compilation/compile.js";
import type { NewsSnapshotPayload } from "../../packages/news/src/personalization-domain.js";
import type { NewsStoryFeedbackPort } from "../../packages/news/src/story-feedback-port.js";

const db = {} as DataContextDb;
const now = new Date("2026-07-11T12:00:00.000Z");

function source(index = 1) {
  return {
    id: `source-${index}`,
    label: `Publisher ${index}`,
    canonicalDomain: `publisher-${index}.example.com`,
    homepageUrl: `https://publisher-${index}.example.com`,
    feedUrl: `https://publisher-${index}.example.com/feed.xml`,
    retrievalMethod: "feed" as const,
    validationStatus: "approved" as const,
    healthStatus: "healthy" as const,
    createdAt: now.toISOString()
  };
}

function feed(domain: string, count = 1): string {
  return `<?xml version="1.0"?><rss><channel>${Array.from(
    { length: count },
    (_, index) =>
      `<item><title>Headline ${index} from ${domain}</title><link>https://${domain}/story-${index}</link><pubDate>Fri, 11 Jul 2026 11:00:00 GMT</pubDate></item>`
  ).join("")}</channel></rss>`;
}

function makeRepo(
  options: {
    sources?: ReturnType<typeof source>[];
    publish?: boolean;
    payloads?: NewsSnapshotPayload[];
    unavailable?: string[];
  } = {}
) {
  return {
    listCustomSources: async () => options.sources ?? [],
    listCustomTopics: async () => [],
    listExclusions: async () => [],
    readPolicyVerdict: async () => null,
    upsertPolicyVerdict: async () => undefined,
    updateSourceHealth: async (_db: DataContextDb, sourceId: string) => {
      options.unavailable?.push(sourceId);
    },
    recordWorkaroundRefreshOutcome: async () => undefined,
    publishSnapshotIfCurrent: async (
      _db: DataContextDb,
      _generation: number,
      input: { payload: unknown }
    ) => {
      options.payloads?.push(input.payload as NewsSnapshotPayload);
      return options.publish ?? true;
    }
  };
}

function dependencies(
  options: {
    sources?: ReturnType<typeof source>[];
    fetchFailure?: boolean;
    aiFailure?: boolean;
    publish?: boolean;
    payloads?: NewsSnapshotPayload[];
    unavailable?: string[];
    warnings?: Record<string, unknown>[];
    storyFeedback?: NewsStoryFeedbackPort;
  } = {}
) {
  return {
    ...(options.storyFeedback ? { storyFeedback: options.storyFeedback } : {}),
    fetch: async (url: string) => {
      if (options.fetchFailure) return { ok: false as const, reason: "network" as const };
      const domain = new URL(url).hostname;
      return {
        ok: true as const,
        status: 200,
        finalUrl: url,
        contentType: "application/rss+xml",
        body: feed(domain, 15),
        truncated: false
      };
    },
    search: { search: async () => ({ results: [] }) },
    ai: {
      fingerprint: async () => "fp",
      generateJson: async (_db: DataContextDb, input: { prompt: string }) => {
        if (options.aiFailure) return { ok: false as const, error: "provider_error" as const };
        const ids = [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match) => match[1]);
        return {
          ok: true as const,
          object: {
            rankings: ids.map((id, index) => ({ id, relevance: 100 - index, eligible: true }))
          }
        };
      }
    },
    repo: makeRepo(options),
    prefs: { list: async () => [] },
    catalog: [],
    logger: {
      info: () => undefined,
      warn: (fields: Record<string, unknown>) => options.warnings?.push(fields)
    }
  };
}

describe("compilePersonalizedNews", () => {
  it("publishes a bounded validated snapshot through the generation CAS", async () => {
    const payloads: NewsSnapshotPayload[] = [];
    const result = await compilePersonalizedNews(
      db,
      dependencies({ sources: [source(1), source(2), source(3)], payloads }),
      { now, generation: 7 }
    );
    expect(result).toEqual({ outcome: "replaced" });
    expect(payloads[0]?.articles).toHaveLength(40);
    expect(payloads[0]?.articles.every((article) => article.publishedAt.endsWith("Z"))).toBe(true);
    expect(JSON.stringify(payloads[0])).not.toContain("fingerprint");
  });

  it("publishes a deterministic snapshot and warns when AI ranking fails", async () => {
    const payloads: NewsSnapshotPayload[] = [];
    const warnings: Record<string, unknown>[] = [];
    await expect(
      compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], aiFailure: true, payloads, warnings }),
        { now, generation: 1 }
      )
    ).resolves.toEqual({ outcome: "replaced" });
    expect(payloads[0]?.articles).toHaveLength(15);
    expect(Object.keys(warnings[0] ?? {}).sort()).toEqual(["aiError", "candidateCount", "event"]);
    expect(warnings).toEqual([
      { event: "news_compile_ai_fallback", aiError: "provider_error", candidateCount: 15 }
    ]);
  });

  it("keeps the last good snapshot and marks a failed source unavailable", async () => {
    const unavailable: string[] = [];
    await expect(
      compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], fetchFailure: true, unavailable }),
        { now, generation: 1 }
      )
    ).resolves.toEqual({ outcome: "kept_last_good", failureKind: "fetch" });
    expect(unavailable).toEqual(["source-1"]);
  });

  it("publishes an empty snapshot after a successful collection with no candidates", async () => {
    const payloads: NewsSnapshotPayload[] = [];
    await expect(
      compilePersonalizedNews(db, dependencies({ payloads }), { now, generation: 1 })
    ).resolves.toEqual({ outcome: "replaced" });
    expect(payloads).toEqual([{ articles: [] }]);
  });

  it("reports stale when the generation CAS rejects publication", async () => {
    await expect(
      compilePersonalizedNews(db, dependencies({ sources: [source()], publish: false }), {
        now,
        generation: 1
      })
    ).resolves.toEqual({ outcome: "stale" });
  });

  // #2018: the owner's story preferences are applied before anything is ranked or published.
  describe("story relevance", () => {
    /** A stand-in for the seam the composition root fills. One story per feed item. */
    function feedbackPort(
      decide: (candidates: readonly StoryRelevanceCandidate[]) => StoryRelevanceResult
    ): NewsStoryFeedbackPort & { seen: StoryRelevanceCandidate[][] } {
      const seen: StoryRelevanceCandidate[][] = [];
      return {
        seen,
        storyRef: (canonicalUrl: string) => `news:${canonicalUrl}`,
        listDismissedRefs: async () => new Set(),
        registerTargets: async () => undefined,
        applyRelevance: async (_db, input) => {
          seen.push([...input.candidates]);
          return decide(input.candidates);
        }
      };
    }

    it("never publishes a story the owner asked to see less of", async () => {
      const payloads: NewsSnapshotPayload[] = [];
      const suppressedUrl = "https://publisher-1.example.com/story-0";
      const port = feedbackPort((candidates) => ({
        status: "applied",
        kept: candidates.filter((candidate) => candidate.storyRef !== `news:${suppressedUrl}`),
        boosts: [],
        suppressedCount: 1,
        overriddenCount: 0
      }));

      await expect(
        compilePersonalizedNews(
          db,
          dependencies({ sources: [source()], payloads, storyFeedback: port }),
          { now, generation: 1, ownerUserId: "owner-1" }
        )
      ).resolves.toEqual({ outcome: "replaced" });

      expect(payloads[0]?.articles).toHaveLength(14);
      expect(payloads[0]?.articles.map((article) => article.url)).not.toContain(suppressedUrl);
      // The relevance layer was shown every surviving candidate, not a sample.
      expect(port.seen[0]).toHaveLength(15);
      expect(port.seen[0]?.[0]?.editorialEvidence).toEqual(["source_lead_position"]);
    });

    it("lets a boosted story outrank an equal-scoring one", async () => {
      const payloads: NewsSnapshotPayload[] = [];
      const boostedUrl = "https://publisher-1.example.com/story-9";
      const port = feedbackPort((candidates) => ({
        status: "applied",
        kept: [...candidates],
        boosts: [{ storyRef: `news:${boostedUrl}`, lift: 50 }],
        suppressedCount: 0,
        overriddenCount: 0
      }));

      await compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], payloads, storyFeedback: port }),
        { now, generation: 1, ownerUserId: "owner-1" }
      );

      const withoutBoost: NewsSnapshotPayload[] = [];
      await compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], payloads: withoutBoost }),
        {
          now,
          generation: 1,
          ownerUserId: "owner-1"
        }
      );

      expect(payloads[0]?.articles[0]?.url).toBe(boostedUrl);
      expect(withoutBoost[0]?.articles[0]?.url).not.toBe(boostedUrl);
      // A nudge, not a takeover: every story is still on the page.
      expect(payloads[0]?.articles).toHaveLength(15);
    });

    it("publishes nothing and reports a failed run when relevance cannot be trusted", async () => {
      const payloads: NewsSnapshotPayload[] = [];
      const warnings: Record<string, unknown>[] = [];
      const port = feedbackPort(() => ({
        status: "degraded",
        failure: "provider_error",
        excludedRefs: [],
        kept: []
      }));

      await expect(
        compilePersonalizedNews(
          db,
          dependencies({ sources: [source()], payloads, warnings, storyFeedback: port }),
          { now, generation: 1, ownerUserId: "owner-1" }
        )
      ).resolves.toEqual({ outcome: "kept_last_good", failureKind: "ai" });

      // A half-filtered page is worse than a stale one.
      expect(payloads).toEqual([]);
      expect(warnings[0]?.event).toBe("news_compile_relevance_degraded");
      // Counts only: no headline, link or story reference in the log line.
      expect(Object.keys(warnings[0] ?? {}).sort()).toEqual([
        "candidateCount",
        "durationMs",
        "event",
        "excludedCount",
        "failure",
        "keptCount"
      ]);
    });

    it("still drops a suppressed story when AI ranking falls back", async () => {
      const payloads: NewsSnapshotPayload[] = [];
      const suppressedUrl = "https://publisher-1.example.com/story-3";
      const port = feedbackPort((candidates) => ({
        status: "applied",
        kept: candidates.filter((candidate) => candidate.storyRef !== `news:${suppressedUrl}`),
        boosts: [],
        suppressedCount: 1,
        overriddenCount: 0
      }));

      await compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], aiFailure: true, payloads, storyFeedback: port }),
        { now, generation: 1, ownerUserId: "owner-1" }
      );

      expect(payloads[0]?.articles.map((article) => article.url)).not.toContain(suppressedUrl);
      expect(payloads[0]?.articles).toHaveLength(14);
    });

    it("skips relevance entirely when nobody is signed in to apply it for", async () => {
      const port = feedbackPort(() => ({
        status: "applied",
        kept: [],
        boosts: [],
        suppressedCount: 0,
        overriddenCount: 0
      }));
      const payloads: NewsSnapshotPayload[] = [];

      await compilePersonalizedNews(
        db,
        dependencies({ sources: [source()], payloads, storyFeedback: port }),
        { now, generation: 1 }
      );

      expect(port.seen).toEqual([]);
      expect(payloads[0]?.articles).toHaveLength(15);
    });
  });
});
