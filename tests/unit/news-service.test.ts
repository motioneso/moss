import { describe, expect, it } from "vitest";

import type { DatasetClient, DatasetEnvelope } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import type {
  NewsCustomSourceDto,
  NewsCustomTopicDto,
  NewsPrefDto,
  NewsSourceExclusionDto
} from "@moss/shared";

import {
  NewsService,
  resolveEffectivePrefs,
  type NewsServiceDependencies
} from "../../packages/news/src/news-service.js";
import type { RssFeedItem } from "../../packages/news/src/source/rss-source.js";
import type { NewsSnapshotRecord } from "../../packages/news/src/personalization-repository.js";
import type { NewsSnapshotArticle } from "../../packages/news/src/personalization-domain.js";
import type {
  NewsStoryFeedbackPort,
  NewsStoryTargetRow
} from "../../packages/news/src/story-feedback-port.js";

/**
 * Fake `DatasetClient` dispatching by (sourceKey, topicKey). Mirrors the sports-service stub's
 * hard-won shape (#857 Fable C1): an UNDECLARED dataset key throws OUTSIDE the fallback try —
 * exactly like the production DatasetClient — so a service/manifest key mismatch fails the test
 * instead of masquerading as a degraded fetch. News declares exactly one dataset: "feed".
 */
const DECLARED_DATASET_KEYS = new Set(["feed"]);

type FeedHandler = (sourceKey: string, topicKey: string | null) => Promise<RssFeedItem[]>;

function makeDatasetClient(getFeed: FeedHandler): DatasetClient {
  return {
    async getDataset<T>(
      datasetKey: string,
      params: Record<string, unknown>,
      options: { fallback: T }
    ): Promise<DatasetEnvelope<T>> {
      if (!DECLARED_DATASET_KEYS.has(datasetKey)) {
        throw new Error(`Unknown dataset "${datasetKey}" for external source "newsfeeds"`);
      }
      try {
        const data = await getFeed(params.sourceKey as string, params.topicKey as string | null);
        return { data: data as T, degraded: false, fetchedAt: new Date().toISOString() };
      } catch {
        return { data: options.fallback, degraded: true, fetchedAt: new Date().toISOString() };
      }
    }
  };
}

const userA: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

let itemCounter = 0;
function item(overrides: Partial<RssFeedItem> = {}): RssFeedItem {
  itemCounter += 1;
  return {
    id: `i-${itemCounter}`,
    title: `Story ${itemCounter}`,
    url: `https://example.com/${itemCounter}`,
    publishedAt: "2026-07-08T12:00:00.000Z",
    imageUrl: null,
    summary: "",
    ...overrides
  };
}

let prefCounter = 0;
function pref(kind: NewsPrefDto["kind"], key: string): NewsPrefDto {
  prefCounter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(prefCounter).padStart(12, "0")}`,
    kind,
    key,
    createdAt: "2026-07-08T00:00:00.000Z"
  };
}

let exclusionCounter = 0;
function exclusion(canonicalDomain: string): NewsSourceExclusionDto {
  exclusionCounter += 1;
  return {
    id: `10000000-0000-0000-0000-${String(exclusionCounter).padStart(12, "0")}`,
    canonicalDomain,
    createdAt: "2026-07-11T00:00:00.000Z"
  };
}

function makeDeps(
  overrides: {
    getFeed?: FeedHandler;
    prefs?: NewsPrefDto[];
    exclusions?: NewsSourceExclusionDto[];
    customSources?: NewsCustomSourceDto[];
    customTopics?: NewsCustomTopicDto[];
    snapshot?: NewsSnapshotRecord | null;
    now?: Date;
    storyFeedback?: NewsStoryFeedbackPort;
  } = {}
): NewsServiceDependencies {
  const prefs = overrides.prefs ?? [];
  const exclusions = overrides.exclusions ?? [];
  return {
    datasetClient: makeDatasetClient(overrides.getFeed ?? (async () => [item()])),
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    },
    repository: {
      list: async () => prefs
    },
    personalization: {
      listExclusions: async () => exclusions,
      listCustomSources: async () => overrides.customSources ?? [],
      listCustomTopics: async () => overrides.customTopics ?? [],
      readLatestSnapshot: async () => overrides.snapshot ?? null
    },
    now: () => overrides.now ?? new Date("2026-07-11T12:00:00.000Z"),
    ...(overrides.storyFeedback ? { storyFeedback: overrides.storyFeedback } : {})
  };
}

function snapshot(
  articles: NewsSnapshotArticle[] = [],
  overrides: Partial<NewsSnapshotRecord> = {}
): NewsSnapshotRecord {
  return {
    compiledAt: new Date("2026-07-11T11:45:00.000Z"),
    expiresAt: new Date("2026-07-12T12:00:00.000Z"),
    payload: { articles },
    ...overrides
  };
}

function snapshotArticle(
  id: string,
  overrides: Partial<NewsSnapshotArticle> = {}
): NewsSnapshotArticle {
  return {
    id,
    publisher: "Preferred Wire",
    canonicalDomain: "preferred.example",
    headline: `Headline ${id}`,
    url: `https://preferred.example/${id}`,
    publishedAt: "2026-07-11T10:00:00.000Z",
    excerpt: "Plain summary",
    imageUrl: `https://images.example/${id}.png`,
    topics: ["AI", "Watches", "3D printing", "ignored"],
    preferred: true,
    rank: 1,
    ...overrides
  };
}

describe("NewsService personalized snapshot overview", () => {
  it("preserves the full rank, hides publisher image URLs, and groups preferred stories only", async () => {
    const articles = [
      snapshotArticle("one"),
      snapshotArticle("two", {
        publisher: "Neutral Journal",
        canonicalDomain: "neutral.example",
        url: "https://neutral.example/two",
        preferred: false,
        imageUrl: null,
        topics: ["AI"],
        rank: 2
      }),
      snapshotArticle("three", { rank: 3, imageUrl: null, topics: [] })
    ];
    const service = new NewsService(
      makeDeps({
        snapshot: snapshot(articles),
        customSources: [
          {
            id: "source-1",
            label: "Preferred Wire",
            canonicalDomain: "preferred.example",
            homepageUrl: "https://preferred.example",
            feedUrl: null,
            retrievalMethod: "scrape",
            validationStatus: "approved",
            healthStatus: "healthy",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ],
        customTopics: [
          {
            id: "topic-1",
            label: "AI",
            guidance: null,
            validationStatus: "approved",
            createdAt: "2026-07-11T00:00:00.000Z"
          }
        ]
      })
    );

    const overview = await service.getOverview(userA);

    expect(overview.rankedStories?.map((story) => story.id)).toEqual(["one", "two", "three"]);
    expect(overview.topStories).toEqual(overview.rankedStories);
    expect(overview.rankedStories?.[0]).toMatchObject({
      imageUrl: "/api/news/images/one",
      topicLabels: ["AI", "Watches", "3D printing"]
    });
    expect(JSON.stringify(overview)).not.toContain("images.example");
    expect(overview.sourceGroups).toHaveLength(1);
    expect(overview.sourceGroups[0]?.headlines.map((story) => story.id)).toEqual(["one", "three"]);
    expect(overview.enabledSources).toContainEqual({
      sourceKey: "source-1",
      label: "Preferred Wire"
    });
    expect(overview.activeTopics).toContain("AI");
  });

  it("keeps valid empty and all-aged-out snapshots personalized", async () => {
    for (const record of [
      snapshot([]),
      snapshot([snapshotArticle("old", { publishedAt: "2026-07-04T11:59:59.999Z" })])
    ]) {
      const overview = await new NewsService(makeDeps({ snapshot: record })).getOverview(userA);
      expect(overview.rankedStories).toEqual([]);
      expect(overview.topStories).toEqual([]);
    }
  });

  it("keeps the seven-day boundary and falls back for expired or invalid snapshots", async () => {
    const atBoundary = await new NewsService(
      makeDeps({
        snapshot: snapshot([
          snapshotArticle("boundary", { publishedAt: "2026-07-04T12:00:00.000Z" })
        ])
      })
    ).getOverview(userA);
    expect(atBoundary.rankedStories?.map((story) => story.id)).toEqual(["boundary"]);

    for (const record of [
      snapshot([], { expiresAt: new Date("2026-07-11T12:00:00.000Z") }),
      snapshot([], { payload: { articles: [{ title: "invalid" }] } })
    ]) {
      const overview = await new NewsService(makeDeps({ snapshot: record })).getOverview(userA);
      expect(overview.rankedStories).toBeUndefined();
      expect(overview.topStories.length).toBeGreaterThan(0);
    }
  });

  it("uses the same personalized snapshot for briefing facts", async () => {
    const service = new NewsService(
      makeDeps({
        snapshot: snapshot([snapshotArticle("one"), snapshotArticle("two", { rank: 2 })])
      })
    );
    const { facts } = await service.getTopHeadlinesForToday({} as DataContextDb);
    expect(facts).toEqual(["Headline one — Preferred Wire", "Headline two — Preferred Wire"]);
  });
});

describe("resolveEffectivePrefs (#897)", () => {
  it("with no prefs, serves the catalog defaults (bbc, guardian, ap, npr)", () => {
    const { sources, topics } = resolveEffectivePrefs([]);
    expect(sources.map((s) => s.sourceKey)).toEqual(["bbc", "guardian", "ap", "npr"]);
    expect(topics).toEqual([]);
  });

  it("any include row replaces the default base entirely", () => {
    const { sources } = resolveEffectivePrefs([pref("source", "nytimes")]);
    expect(sources.map((s) => s.sourceKey)).toEqual(["nytimes"]);
  });

  it("excludes beat both defaults and includes", () => {
    expect(
      resolveEffectivePrefs([pref("source_exclude", "guardian")]).sources.map((s) => s.sourceKey)
    ).toEqual(["bbc", "ap", "npr"]);
    expect(
      resolveEffectivePrefs([
        pref("source", "nytimes"),
        pref("source", "wired"),
        pref("source_exclude", "wired")
      ]).sources.map((s) => s.sourceKey)
    ).toEqual(["nytimes"]);
  });

  it("ignores prefs whose key left the catalog (a removed source can't wedge the page)", () => {
    const { sources } = resolveEffectivePrefs([
      pref("source", "nytimes"),
      pref("source", "defunct-source")
    ]);
    expect(sources.map((s) => s.sourceKey)).toEqual(["nytimes"]);
  });

  it("maps topic rows through the catalog and drops unknown topic keys", () => {
    const { topics } = resolveEffectivePrefs([
      pref("topic", "technology"),
      pref("topic", "not-a-topic")
    ]);
    expect(topics).toEqual(["technology"]);
  });
});

describe("NewsService.getOverview (#897)", () => {
  it("caps topStories at 6 across the ranked pool", async () => {
    const service = new NewsService(
      makeDeps({ getFeed: async () => Array.from({ length: 10 }, () => item()) })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories).toHaveLength(6);
  });

  it("fetches only the top feed per source when no topics are selected", async () => {
    const calls: { sourceKey: string; topicKey: string | null }[] = [];
    const service = new NewsService(
      makeDeps({
        getFeed: async (sourceKey, topicKey) => {
          calls.push({ sourceKey, topicKey });
          return [];
        }
      })
    );
    await service.getOverview(userA);
    expect(calls).toEqual([
      { sourceKey: "bbc", topicKey: null },
      { sourceKey: "guardian", topicKey: null },
      { sourceKey: "ap", topicKey: null },
      { sourceKey: "npr", topicKey: null }
    ]);
  });

  it("skips a source that doesn't map a selected topic (BBC has no politics feed)", async () => {
    const calls: { sourceKey: string; topicKey: string | null }[] = [];
    const service = new NewsService(
      makeDeps({
        prefs: [pref("topic", "politics")],
        getFeed: async (sourceKey, topicKey) => {
          calls.push({ sourceKey, topicKey });
          return [];
        }
      })
    );
    await service.getOverview(userA);
    // guardian + ap + npr map politics; bbc must not be fetched at all for it.
    expect(calls).toEqual([
      { sourceKey: "guardian", topicKey: "politics" },
      { sourceKey: "ap", topicKey: "politics" },
      { sourceKey: "npr", topicKey: "politics" }
    ]);
  });

  it("dedupes a story that appears in two topic feeds of the SAME source", async () => {
    // NYT maps every topic; the same wire story often sits in both selected feeds. The first
    // plan's copy wins (keeps its topic tag); the duplicate must not double-render.
    const shared = item({ id: "dup-1" });
    const service = new NewsService(
      makeDeps({
        prefs: [pref("source", "nytimes"), pref("topic", "technology"), pref("topic", "science")],
        getFeed: async () => [shared]
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.sourceGroups).toHaveLength(1);
    expect(overview.sourceGroups[0]?.headlines).toHaveLength(1);
    expect(overview.sourceGroups[0]?.headlines[0]?.topicKey).toBe("technology");
  });

  it("does NOT dedupe across sources (differing coverage of one event is a feature)", async () => {
    const service = new NewsService(
      makeDeps({ getFeed: async () => [item({ id: "same-id", url: "https://example.com/x" })] })
    );
    const overview = await service.getOverview(userA);
    // bbc, guardian, ap, npr each contribute their copy.
    expect(overview.topStories).toHaveLength(4);
  });

  it("enriches headlines with source identity and the human topic label", async () => {
    const service = new NewsService(
      makeDeps({
        prefs: [pref("topic", "technology")],
        getFeed: async (sourceKey) => (sourceKey === "bbc" ? [item()] : [])
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories[0]).toMatchObject({
      sourceKey: "bbc",
      sourceLabel: "BBC News",
      topicKey: "technology",
      topicLabel: "Technology"
    });
  });

  it("drops empty source groups but keeps the source in enabledSources", async () => {
    const service = new NewsService(
      makeDeps({ getFeed: async (sourceKey) => (sourceKey === "npr" ? [item()] : []) })
    );
    const overview = await service.getOverview(userA);
    expect(overview.sourceGroups.map((g) => g.sourceKey)).toEqual(["npr"]);
    // enabledSources reflects prefs, not fetch luck — the settings pane keys off it.
    expect(overview.enabledSources).toEqual([
      { sourceKey: "bbc", label: "BBC News" },
      { sourceKey: "guardian", label: "The Guardian" },
      { sourceKey: "ap", label: "AP News" },
      { sourceKey: "npr", label: "NPR" }
    ]);
  });

  it("caps each source group at 12 headlines", async () => {
    const service = new NewsService(
      makeDeps({ getFeed: async () => Array.from({ length: 20 }, () => item()) })
    );
    const overview = await service.getOverview(userA);
    for (const group of overview.sourceGroups) expect(group.headlines).toHaveLength(12);
  });

  it("degrades (no throw) when one publisher's feed fails, keeping the others", async () => {
    const service = new NewsService(
      makeDeps({
        getFeed: async (sourceKey) => {
          if (sourceKey === "guardian") throw new Error("origin 503");
          return [item()];
        }
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.degraded).toBe(true);
    expect(overview.sourceGroups.map((g) => g.sourceKey)).toEqual(["bbc", "ap", "npr"]);
  });

  it("reports activeTopics so the page can render the topic filter state", async () => {
    const service = new NewsService(
      makeDeps({ prefs: [pref("topic", "world")], getFeed: async () => [] })
    );
    const overview = await service.getOverview(userA);
    expect(overview.activeTopics).toEqual(["world"]);
  });
});

describe("NewsService exclusion filtering (#953 Slice 1)", () => {
  it("drops a curated source whose homepage domain is excluded BEFORE any fetch", async () => {
    const calls: string[] = [];
    const service = new NewsService(
      makeDeps({
        exclusions: [exclusion("bbc.com")], // homepage www.bbc.com is a subdomain match
        getFeed: async (sourceKey) => {
          calls.push(sourceKey);
          return [item()];
        }
      })
    );
    const overview = await service.getOverview(userA);
    expect(calls).toEqual(["guardian", "ap", "npr"]);
    expect(overview.sourceGroups.map((g) => g.sourceKey)).toEqual(["guardian", "ap", "npr"]);
    expect(overview.enabledSources.map((s) => s.sourceKey)).toEqual(["guardian", "ap", "npr"]);
  });

  it("drops composed headlines whose article hostname matches an exclusion via ANOTHER feed", async () => {
    // An excluded domain must never appear through a different curated feed: the guardian
    // feed here carries a syndicated copy hosted on the excluded domain (and one on a
    // subdomain of it); both must vanish while the guardian's own story survives.
    const service = new NewsService(
      makeDeps({
        exclusions: [exclusion("syndicated.example")],
        getFeed: async (sourceKey) =>
          sourceKey === "guardian"
            ? [
                item({ url: "https://syndicated.example/wire-story" }),
                item({ url: "https://cdn.syndicated.example/wire-story-2" }),
                item({ url: "https://www.theguardian.com/own-story" })
              ]
            : []
      })
    );
    const overview = await service.getOverview(userA);
    const urls = overview.topStories.map((h) => h.url);
    expect(urls).toEqual(["https://www.theguardian.com/own-story"]);
  });

  it("does not match suffix tricks (excluding example.com keeps notexample.com)", async () => {
    const service = new NewsService(
      makeDeps({
        exclusions: [exclusion("example.com")],
        getFeed: async (sourceKey) =>
          sourceKey === "npr" ? [item({ url: "https://notexample.com/story" })] : []
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories.map((h) => h.url)).toEqual(["https://notexample.com/story"]);
  });

  it("drops headlines whose URL is malformed or missing — fail closed (PR #955 Codex finding)", async () => {
    // A headline URL that cannot be parsed cannot be proven NOT-excluded, so it must be
    // dropped rather than fall through the exclusion filter. Covers both the malformed and
    // the missing/empty URL shape a broken or hostile feed could emit.
    const service = new NewsService(
      makeDeps({
        exclusions: [exclusion("example.com")],
        getFeed: async (sourceKey) =>
          sourceKey === "npr"
            ? [
                item({ url: "not a url" }),
                item({ url: "" }),
                item({ url: "https://ok.example.org/story" })
              ]
            : []
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories.map((h) => h.url)).toEqual(["https://ok.example.org/story"]);
  });

  it("drops malformed-URL headlines even when the user has NO exclusions", async () => {
    // Fail-closed is unconditional: the null-hostname branch must not depend on the
    // exclusion list being non-empty.
    const service = new NewsService(
      makeDeps({
        getFeed: async (sourceKey) =>
          sourceKey === "npr"
            ? [item({ url: "http://[broken" }), item({ url: "https://ok.example.org/story" })]
            : []
      })
    );
    const overview = await service.getOverview(userA);
    expect(overview.topStories.map((h) => h.url)).toEqual(["https://ok.example.org/story"]);
  });

  it("keeps exclusions effective on the briefing path (getTopHeadlinesForToday)", async () => {
    const service = new NewsService(
      makeDeps({
        exclusions: [exclusion("bbc.com")],
        getFeed: async (sourceKey) => (sourceKey === "bbc" ? [item(), item()] : [item()])
      })
    );
    const { facts } = await service.getTopHeadlinesForToday({} as DataContextDb);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(fact).not.toContain("BBC News");
  });
});

describe("NewsService.getCatalog (#897)", () => {
  it("lists all 9 curated sources with their per-source topic coverage", () => {
    const catalog = new NewsService(makeDeps()).getCatalog();
    expect(catalog.sources).toHaveLength(9);
    expect(catalog.topics).toHaveLength(8);
    const bbc = catalog.sources.find((s) => s.sourceKey === "bbc");
    expect(bbc?.defaultEnabled).toBe(true);
    expect(bbc?.topics).not.toContain("politics"); // BBC publishes no politics RSS feed
    const verge = catalog.sources.find((s) => s.sourceKey === "verge");
    expect(verge?.topics).toEqual(["technology"]);
  });
});

describe("NewsService.getTopHeadlinesForToday (#897)", () => {
  it("returns compact 'Title — Source' facts capped at 5 (briefing budget)", async () => {
    const service = new NewsService(
      makeDeps({
        getFeed: async (sourceKey) =>
          sourceKey === "bbc" ? Array.from({ length: 8 }, () => item()) : []
      })
    );
    const { facts } = await service.getTopHeadlinesForToday({} as DataContextDb);
    expect(facts).toHaveLength(5);
    expect(facts[0]).toMatch(/^Story \d+ — BBC News$/);
  });

  it("returns no facts (no throw) when every feed fails", async () => {
    const service = new NewsService(
      makeDeps({
        getFeed: async () => {
          throw new Error("all origins down");
        }
      })
    );
    const { facts } = await service.getTopHeadlinesForToday({} as DataContextDb);
    expect(facts).toEqual([]);
  });
});

// #2018: a story can only be given a preference if it was actually shown to that user, and the
// only thing that records "shown" is this overview.
describe("NewsService story feedback references (#2018)", () => {
  /** Records what the composition root's port would have been asked to write. */
  function recordingPort(): NewsStoryFeedbackPort & { written: NewsStoryTargetRow[][] } {
    const written: NewsStoryTargetRow[][] = [];
    return {
      written,
      storyRef: (canonicalUrl: string) => `news:ref-for-${canonicalUrl}`,
      listDismissedRefs: async () => new Set(),
      registerTargets: async (_db, _ownerUserId, rows) => {
        written.push([...rows]);
      },
      applyRelevance: async () => ({
        status: "applied",
        kept: [],
        boosts: [],
        suppressedCount: 0,
        overriddenCount: 0
      })
    };
  }

  it("gives every story on the personalized page a reference feedback can be saved against", async () => {
    const port = recordingPort();
    const service = new NewsService(
      makeDeps({
        snapshot: snapshot([snapshotArticle("one"), snapshotArticle("two", { rank: 2 })]),
        storyFeedback: port
      })
    );

    const overview = await service.getOverview(userA);

    expect(overview.rankedStories?.map((story) => story.feedbackRef)).toEqual([
      "news:ref-for-https://preferred.example/one",
      "news:ref-for-https://preferred.example/two"
    ]);
  });

  it("offers no reference on the live-feed fallback, which has no story to verify against", async () => {
    const port = recordingPort();
    const service = new NewsService(makeDeps({ snapshot: null, storyFeedback: port }));

    const overview = await service.getOverview(userA);

    // The fallback answer has no ranked list at all; its stories come straight off live feeds.
    expect(overview.rankedStories).toBeUndefined();
    expect(overview.topStories.length).toBeGreaterThan(0);
    expect(overview.topStories.every((story) => story.feedbackRef === undefined)).toBe(true);
    expect(port.written).toEqual([]);
  });

  it("records each story it returned, on both the news page and the Today widget", async () => {
    const port = recordingPort();
    const service = new NewsService(
      makeDeps({ snapshot: snapshot([snapshotArticle("one")]), storyFeedback: port })
    );

    await service.getOverview(userA);

    expect(port.written).toHaveLength(1);
    expect(port.written[0]).toEqual([
      {
        storyRef: "news:ref-for-https://preferred.example/one",
        surface: "news",
        headline: "Headline one",
        sourceLabel: "Preferred Wire",
        publishedAt: "2026-07-11T10:00:00.000Z",
        topicRef: "AI",
        hasEditorialEvidence: true
      },
      {
        storyRef: "news:ref-for-https://preferred.example/one",
        surface: "today",
        headline: "Headline one",
        sourceLabel: "Preferred Wire",
        publishedAt: "2026-07-11T10:00:00.000Z",
        topicRef: "AI",
        hasEditorialEvidence: true
      }
    ]);
  });

  it("records a full page of stories, on both surfaces", async () => {
    const port = recordingPort();
    // Forty is the most a published snapshot may hold, so it is also the most that can be shown.
    const articles = Array.from({ length: 40 }, (_, index) =>
      snapshotArticle(`story-${index}`, { rank: index + 1 })
    );
    const service = new NewsService(
      makeDeps({ snapshot: snapshot(articles), storyFeedback: port })
    );

    await service.getOverview(userA);

    // Two surfaces per story.
    expect(port.written[0]).toHaveLength(80);
    expect(new Set(port.written[0]?.map((row) => row.storyRef)).size).toBe(40);
  });

  it("still shows the news when recording the stories fails", async () => {
    const port = recordingPort();
    port.registerTargets = async () => {
      throw new Error("target write failed");
    };
    const service = new NewsService(
      makeDeps({ snapshot: snapshot([snapshotArticle("one")]), storyFeedback: port })
    );

    const overview = await service.getOverview(userA);

    expect(overview.rankedStories).toHaveLength(1);
    expect(overview.rankedStories?.[0]?.feedbackRef).toBeUndefined();
  });
});

describe("NewsService dismissed-story filtering on read (#2247)", () => {
  it("does not bring back a story the owner has dismissed, even from an already-saved list", async () => {
    const port: NewsStoryFeedbackPort = {
      storyRef: (canonicalUrl: string) => `news:ref-for-${canonicalUrl}`,
      listDismissedRefs: async () => new Set(["news:ref-for-https://preferred.example/one"]),
      registerTargets: async () => {},
      applyRelevance: async () => ({
        status: "applied",
        kept: [],
        boosts: [],
        suppressedCount: 0,
        overriddenCount: 0
      })
    };
    const service = new NewsService(
      makeDeps({
        snapshot: snapshot([snapshotArticle("one"), snapshotArticle("two")]),
        storyFeedback: port
      })
    );

    const overview = await service.getOverview(userA);

    const urls = overview.topStories.map((story) => story.url);
    expect(urls).not.toContain("https://preferred.example/one");
    expect(urls).toContain("https://preferred.example/two");
  });
});
