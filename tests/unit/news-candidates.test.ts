import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";

import { collectCandidates } from "../../packages/news/src/compilation/candidates.js";
import { applyDeterministicFilters } from "../../packages/news/src/compilation/filters.js";

const db = {} as DataContextDb;
const now = new Date("2026-07-11T12:00:00.000Z");

function feed(items: { title: string; url: string; date?: string }[]): string {
  return `<?xml version="1.0"?><rss><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.url}</link>${
          item.date ? `<pubDate>${item.date}</pubDate>` : ""
        }</item>`
    )
    .join("")}</channel></rss>`;
}

/** One Reddit Atom entry whose "[link]" anchor points out to a publisher. */
function redditEntry(
  id: string,
  title: string,
  url: string,
  published = "2026-07-11T11:00:00+00:00"
): string {
  return (
    `<entry><id>${id}</id><published>${published}</published><updated>${published}</updated>` +
    `<title>${title}</title><content type="html">&lt;a href="${url}"&gt;[link]&lt;/a&gt;</content></entry>`
  );
}

function redditAtomFeed(name: string, entries: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<category term="${name}" label="r/${name}"/><title>Test subreddit</title>` +
    `<subtitle>Testing</subtitle>${entries.join("")}</feed>`
  );
}

function customSubreddit(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-reddit-1",
    label: "r/test",
    canonicalDomain: "reddit.com",
    homepageUrl: "https://www.reddit.com/r/test/",
    feedUrl: "https://www.reddit.com/r/test/hot.rss",
    retrievalMethod: "reddit",
    validationStatus: "approved",
    healthStatus: "healthy",
    createdAt: now.toISOString(),
    ...overrides
  };
}

function repo(overrides: Record<string, unknown> = {}) {
  return {
    listCustomSources: async () => [],
    listCustomTopics: async () => [],
    listExclusions: async () => [],
    readPolicyVerdict: async () => null,
    upsertPolicyVerdict: async () => undefined,
    recordWorkaroundRefreshOutcome: async () => undefined,
    ...overrides
  };
}

const emptyCatalog: readonly never[] = [];

describe("collectCandidates", () => {
  it("never fetches an excluded source", async () => {
    let fetches = 0;
    const result = await collectCandidates(
      db,
      {
        fetch: async () => {
          fetches += 1;
          return { ok: false, reason: "network" };
        },
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({
          listCustomSources: async () => [
            {
              id: "source-1",
              label: "Excluded",
              canonicalDomain: "news.example.com",
              homepageUrl: "https://news.example.com",
              feedUrl: "https://news.example.com/feed.xml",
              retrievalMethod: "feed",
              validationStatus: "approved",
              healthStatus: "healthy",
              createdAt: now.toISOString()
            }
          ],
          listExclusions: async () => [
            { id: "ex-1", canonicalDomain: "example.com", createdAt: now.toISOString() }
          ]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );
    expect(fetches).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("drops missing, invalid, and future timestamps and caps a source at 15", async () => {
    const valid = Array.from({ length: 18 }, (_, index) => ({
      title: `<b>Headline ${index} with enough detail</b>`,
      url: `https://example.com/story-${index}`,
      date: "Fri, 11 Jul 2026 11:00:00 GMT"
    }));
    const body = feed([
      ...valid,
      { title: "Missing date", url: "https://example.com/missing" },
      { title: "Invalid date", url: "https://example.com/invalid", date: "not-a-date" },
      { title: "Future date", url: "https://example.com/future", date: "2026-07-11T14:00:00Z" }
    ]);
    const result = await collectCandidates(
      db,
      {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body,
          truncated: false
        }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({
          listCustomSources: async () => [
            {
              id: "source-1",
              label: "Example",
              canonicalDomain: "example.com",
              homepageUrl: "https://example.com",
              feedUrl: "https://example.com/feed.xml",
              retrievalMethod: "feed",
              validationStatus: "approved",
              healthStatus: "healthy",
              createdAt: now.toISOString()
            }
          ]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );
    expect(result.candidates).toHaveLength(15);
    expect(result.candidates.every((candidate) => candidate.headline.length <= 300)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.publishedAt.endsWith("Z"))).toBe(true);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `c${index + 1}`)
    );
  });

  it("default-denies stories from a topic-discovered publisher", async () => {
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "network" }),
        search: {
          search: async () => ({
            results: [
              {
                title: "A relevant and trustworthy headline",
                url: "https://neutral.example/story",
                snippet: "Public snippet",
                publishedAt: "2026-07-11T11:00:00Z"
              }
            ]
          })
        },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({
            ok: true,
            object: { allowed: false, category: "news_publisher" }
          })
        },
        repo: repo({
          listCustomTopics: async () => [
            {
              id: "topic-1",
              label: "Watches",
              guidance: null,
              validationStatus: "approved",
              createdAt: now.toISOString()
            }
          ]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );
    expect(result.candidates).toEqual([]);
  });

  it("enriches an approved topic result with bounded article metadata", async () => {
    let fetchedUrl: string | null = null;
    const result = await collectCandidates(
      db,
      {
        fetch: async (url) => {
          fetchedUrl = url;
          return {
            ok: true,
            status: 200,
            finalUrl: url,
            contentType: "text/html",
            body:
              '<html><head><meta property="article:published_time" content="2026-07-11T10:00:00Z">' +
              '<meta property="og:description" content="Metadata excerpt">' +
              '<meta property="og:image" content="https://images.neutral.example/lead.jpg"></head>' +
              "<body>Article body must not become candidate data.</body></html>",
            truncated: false
          };
        },
        search: {
          search: async () => ({
            results: [
              {
                title: "A relevant headline",
                url: "https://neutral.example/story",
                snippet: ""
              }
            ]
          })
        },
        ai: aiReturningApproved(),
        repo: repo({
          readPolicyVerdict: async () => "approved",
          listCustomTopics: async () => [approvedTopic()]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(fetchedUrl).toBe("https://neutral.example/story");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      publishedAt: "2026-07-11T10:00:00.000Z",
      excerpt: "Metadata excerpt",
      imageUrl: "https://images.neutral.example/lead.jpg"
    });
    expect(JSON.stringify(result.candidates[0])).not.toContain("Article body");
  });

  it("keeps trustworthy search metadata when optional article enrichment fails", async () => {
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "robots" }),
        search: {
          search: async () => ({
            results: [
              {
                title: "A relevant headline",
                url: "https://neutral.example/story",
                snippet: "Search excerpt",
                publishedAt: "2026-07-11T10:00:00Z"
              }
            ]
          })
        },
        ai: aiReturningApproved(),
        repo: repo({
          readPolicyVerdict: async () => "approved",
          listCustomTopics: async () => [approvedTopic()]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(result.candidates[0]).toMatchObject({ excerpt: "Search excerpt", imageUrl: null });
  });

  it("drops topic results whose metadata read redirects to another publisher", async () => {
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          finalUrl: "https://different.example/story",
          contentType: "text/html",
          body: '<meta property="og:image" content="https://different.example/image.jpg">',
          truncated: false
        }),
        search: {
          search: async () => ({
            results: [
              {
                title: "A relevant headline",
                url: "https://neutral.example/story",
                snippet: "Search excerpt",
                publishedAt: "2026-07-11T10:00:00Z"
              }
            ]
          })
        },
        ai: aiReturningApproved(),
        repo: repo({
          readPolicyVerdict: async () => "approved",
          listCustomTopics: async () => [approvedTopic()]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(result.candidates).toEqual([]);
  });

  it("maps a subreddit's headlines to candidates, capped at 10, and survives dedupe once", async () => {
    const body = redditAtomFeed("test", [
      ...Array.from({ length: 12 }, (_, index) =>
        redditEntry(`t3_${index}`, `Story ${index}`, `https://publisher.example/story-${index}`)
      ),
      redditEntry("t3_dup", "Duplicate of story 0", "https://publisher.example/story-0")
    ]);
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "network" }),
        fetchWithOptions: async () => ({
          ok: true,
          status: 200,
          finalUrl: "https://www.reddit.com/r/test/hot.rss",
          contentType: "application/atom+xml",
          body,
          truncated: false
        }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({ listCustomSources: async () => [customSubreddit()] }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(result.candidates).toHaveLength(10);
    expect(result.candidates.every((candidate) => candidate.canonicalDomain === "reddit.com")).toBe(
      true
    );
    expect(result.candidates.every((candidate) => candidate.publisher === "r/test")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.origin === "preferred_source")).toBe(
      true
    );
    expect(result.fetchFailures).toBe(0);

    const filtered = applyDeterministicFilters(
      result.candidates.map((candidate) => ({ ...candidate, matchedTopics: [] })),
      { exclusions: [], approvedDomains: new Set(["reddit.com"]), now }
    );
    const storyZeroCount = filtered.filter(
      (c) => c.url === "https://publisher.example/story-0"
    ).length;
    expect(storyZeroCount).toBe(1);
  });

  it("never fetches a subreddit that is unhealthy, unapproved, or excluded", async () => {
    let fetches = 0;
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "network" }),
        fetchWithOptions: async () => {
          fetches += 1;
          return { ok: false, reason: "network" };
        },
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({
          listCustomSources: async () => [
            customSubreddit({ id: "s-unhealthy", healthStatus: "unhealthy" }),
            customSubreddit({ id: "s-unapproved", validationStatus: "pending" }),
            customSubreddit({ id: "s-excluded" })
          ],
          listExclusions: async () => [
            { id: "ex-1", canonicalDomain: "reddit.com", createdAt: now.toISOString() }
          ]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(fetches).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("marks an auth-required subreddit failure differently from every other failure reason", async () => {
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "network" }),
        fetchWithOptions: async (url) =>
          url.includes("auth")
            ? { ok: false, reason: "http_error", status: 403 }
            : { ok: false, reason: "http_error", status: 500 },
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({
          listCustomSources: async () => [
            customSubreddit({
              id: "s-auth",
              feedUrl: "https://www.reddit.com/r/auth/hot.rss"
            }),
            customSubreddit({
              id: "s-down",
              feedUrl: "https://www.reddit.com/r/down/hot.rss"
            })
          ]
        }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(result.candidates).toEqual([]);
    expect(result.sourceFailures).toEqual(
      expect.arrayContaining([
        { sourceId: "s-auth", reason: "authentication_failed" },
        { sourceId: "s-down", reason: "temporarily_unavailable" }
      ])
    );
    expect(result.sourcesMarkedUnavailable).toEqual(["s-down"]);
  });

  it("skips a subreddit source silently when no options-capable fetch is wired", async () => {
    const result = await collectCandidates(
      db,
      {
        fetch: async () => ({ ok: false, reason: "network" }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({ ok: false, error: "provider_error" })
        },
        repo: repo({ listCustomSources: async () => [customSubreddit()] }),
        prefs: { list: async () => [] },
        catalog: emptyCatalog
      },
      { now }
    );

    expect(result.candidates).toEqual([]);
    expect(result.sourceFailures).toEqual([]);
  });
});

function approvedTopic() {
  return {
    id: "topic-1",
    label: "Watches",
    guidance: null,
    validationStatus: "approved" as const,
    createdAt: now.toISOString()
  };
}

function aiReturningApproved() {
  return {
    fingerprint: async () => "fp",
    generateJson: async () => ({
      ok: true as const,
      object: { allowed: true, category: "news_publisher" }
    })
  };
}
