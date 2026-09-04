import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import type { NewsAiPort, NewsSafeFetchPort } from "../../packages/news/src/discovery/ports.js";
import { resolveSourceInput } from "../../packages/news/src/discovery/source-resolution.js";

const db = {} as DataContextDb;
const feed = `<rss><channel><item><title>A consequential headline today</title><link>https://one.example/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

function ai(allowed = true): NewsAiPort {
  return {
    fingerprint: async () => "fp",
    generateJson: async () => ({
      ok: true,
      object: { allowed, category: "news_publisher" }
    })
  };
}

function repo(exclusions: string[] = []) {
  return {
    listExclusions: vi.fn(async () =>
      exclusions.map((canonicalDomain) => ({ id: canonicalDomain, canonicalDomain, createdAt: "" }))
    ),
    readPolicyVerdict: vi.fn(async () => null),
    upsertPolicyVerdict: vi.fn(async () => {})
  };
}

function fetchMap(
  entries: Record<string, { body: string; contentType?: string }>
): NewsSafeFetchPort {
  return vi.fn(async (url: string) => {
    const entry = entries[url];
    return entry
      ? {
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: entry.contentType ?? "text/html",
          body: entry.body,
          truncated: false
        }
      : { ok: false as const, reason: "network" as const };
  });
}

const noSearch = { search: vi.fn(async () => ({ results: [] })) };

describe("resolveSourceInput", () => {
  it("resolves a direct feed URL and carries validation evidence", async () => {
    const result = await resolveSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://one.example/feed.xml": { body: feed, contentType: "application/rss+xml" }
        }),
        search: noSearch,
        ai: ai(),
        repo: repo()
      },
      { raw: "https://one.example/feed.xml", hasWebSearch: false }
    );
    expect(result).toMatchObject({
      status: "ok",
      candidates: [
        {
          canonicalDomain: "one.example",
          feedUrl: "https://one.example/feed.xml",
          retrievalMethod: "feed",
          sampleCount: 1,
          validationFingerprint: "fp"
        }
      ]
    });
  });

  it("discovers a homepage feed and falls back to listing headlines", async () => {
    const withFeed = await resolveSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://one.example/": {
            body: `<title>One News</title><link rel="alternate" type="application/rss+xml" href="/feed.xml">`
          },
          "https://one.example/feed.xml": { body: feed, contentType: "application/rss+xml" }
        }),
        search: noSearch,
        ai: ai(),
        repo: repo()
      },
      { raw: "https://one.example", hasWebSearch: false }
    );
    expect(withFeed).toMatchObject({ status: "ok", candidates: [{ retrievalMethod: "feed" }] });

    const scraped = await resolveSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://two.example/": {
            body: `<title>Two News</title><a href="/story">A sufficiently important headline today</a>`
          }
        }),
        search: noSearch,
        ai: ai(),
        repo: repo()
      },
      { raw: "https://two.example", hasWebSearch: false }
    );
    expect(scraped).toMatchObject({ status: "ok", candidates: [{ retrievalMethod: "scrape" }] });
  });

  it("turns an article canonical URL into its publisher homepage", async () => {
    const fetch = fetchMap({
      "https://one.example/article": {
        body: `<link rel="canonical" href="https://one.example/canonical-story">`
      },
      "https://one.example/": {
        body: `<title>One News</title><a href="/story">A sufficiently important headline today</a>`
      }
    });
    await expect(
      resolveSourceInput(
        db,
        { fetch, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example/article", hasWebSearch: false }
      )
    ).resolves.toMatchObject({
      status: "ok",
      candidates: [{ homepageUrl: "https://one.example/" }]
    });
    expect(fetch).toHaveBeenCalledWith("https://one.example/");
  });

  it("resolves names to at most three verified ambiguous publishers", async () => {
    const search = {
      search: vi.fn(async () => ({
        results: [
          { title: "One", url: "https://one.example/", snippet: "", publishedAt: "2026-07-11" },
          { title: "Two", url: "https://two.example/", snippet: "", publishedAt: "2026-07-11" }
        ]
      }))
    };
    const fetch = fetchMap({
      "https://one.example/": {
        body: `<title>One</title><a href="/story">A sufficiently important headline today</a>`
      },
      "https://two.example/": {
        body: `<title>Two</title><a href="/story">Another sufficiently important headline</a>`
      }
    });
    await expect(
      resolveSourceInput(
        db,
        { fetch, search, ai: ai(), repo: repo() },
        { raw: "Daily News", hasWebSearch: true }
      )
    ).resolves.toMatchObject({ status: "ambiguous", candidates: [{}, {}] });
  });

  it("rejects homepage and feed redirects that change publisher identity", async () => {
    const homepageRedirect = vi.fn<NewsSafeFetchPort>(async (url) => ({
      ok: true as const,
      status: 200,
      finalUrl: url.endsWith("/article") ? url : "https://evil.test/",
      contentType: "text/html",
      body: url.endsWith("/article")
        ? `<link rel="canonical" href="https://one.example/story">`
        : `<a href="/story">A sufficiently important headline today</a>`,
      truncated: false
    }));
    await expect(
      resolveSourceInput(
        db,
        { fetch: homepageRedirect, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example/article", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });

    const feedRedirect = vi.fn<NewsSafeFetchPort>(async (url) => ({
      ok: true as const,
      status: 200,
      finalUrl: url.endsWith("feed.xml") ? "https://evil.test/feed.xml" : url,
      contentType: url.endsWith("feed.xml") ? "application/rss+xml" : "text/html",
      body: url.endsWith("feed.xml")
        ? feed
        : `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
      truncated: false
    }));
    await expect(
      resolveSourceInput(
        db,
        { fetch: feedRedirect, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "unreachable" });
    expect(feedRedirect).toHaveBeenCalledTimes(2);
  });

  it("fails closed without prerequisites, on exclusions, policy rejection, or fetch challenge", async () => {
    await expect(
      resolveSourceInput(
        db,
        { fetch: fetchMap({}), search: noSearch, ai: ai(), repo: repo() },
        { raw: "Daily News", hasWebSearch: false }
      )
    ).resolves.toEqual({ status: "unavailable" });

    const excludedFetch = fetchMap({});
    await expect(
      resolveSourceInput(
        db,
        { fetch: excludedFetch, search: noSearch, ai: ai(), repo: repo(["example.com"]) },
        { raw: "https://news.example.com", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected" });
    expect(excludedFetch).not.toHaveBeenCalled();

    const excludedSearchFetch = fetchMap({});
    const excludedSearch = {
      search: vi.fn(async () => ({
        results: [
          {
            title: "Blocked",
            url: "https://news.example.com/",
            snippet: "",
            publishedAt: "2026-07-11"
          }
        ]
      }))
    };
    await expect(
      resolveSourceInput(
        db,
        {
          fetch: excludedSearchFetch,
          search: excludedSearch,
          ai: ai(),
          repo: repo(["example.com"])
        },
        { raw: "Blocked News", hasWebSearch: true }
      )
    ).resolves.toMatchObject({ status: "rejected" });
    expect(excludedSearchFetch).not.toHaveBeenCalled();

    const redirectedFetch = vi.fn<NewsSafeFetchPort>(async () => ({
      ok: true,
      status: 200,
      finalUrl: "https://news.example.com/article",
      contentType: "text/html",
      body: `<link rel="canonical" href="https://news.example.com/story">`,
      truncated: false
    }));
    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectedFetch, search: noSearch, ai: ai(), repo: repo(["example.com"]) },
        { raw: "https://alias.test/article", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "policy" });
    expect(redirectedFetch).toHaveBeenCalledTimes(1);

    await expect(
      resolveSourceInput(
        db,
        {
          fetch: fetchMap({
            "https://one.example/": {
              body: `<a href="/story">A sufficiently important headline today</a>`
            }
          }),
          search: noSearch,
          ai: ai(false),
          repo: repo()
        },
        { raw: "https://one.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "policy" });

    const challenged: NewsSafeFetchPort = async () => ({
      ok: false,
      reason: "http_error",
      status: 403
    });
    await expect(
      resolveSourceInput(
        db,
        { fetch: challenged, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "unreachable" });
  });

  // #1265 relay-5 SSRF scope restoration (approved spec lines 47-49): the requested domain is
  // a normal public publisher, but the HTTP redirect chain lands on a private/internal address
  // (SSRF via redirect, not a typed-in IP literal). acceptedFinalDomain in source-resolution.ts
  // must normalize `fetched.finalUrl` (the POST-redirect URL), not the raw input, for this to
  // reject — a check that only validated the typed domain would miss this.
  it("refuses a public domain whose redirect chain lands on a private/internal address", async () => {
    const redirectsToMetadataService: NewsSafeFetchPort = async (url) => {
      if (url === "https://publisher.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "http://169.254.169.254/latest/meta-data/",
          contentType: "text/html",
          body: "<title>internal</title>",
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsToMetadataService, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://publisher.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  // Bug: a page's little accessibility labels for icons (for example a Facebook or Instagram
  // icon inside an SVG in the header or footer) each use their own <title> tag. The label parser
  // used to keep reading every <title> tag it found and glue the text together, so the source
  // name came out as the real title followed by all of those icon labels run together. It should
  // only ever use the first title tag in the page.
  it("uses only the page's own title, not the little icon labels that follow it", async () => {
    const result = await resolveSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://one.example/": {
            body: `<title>The Atlantic</title><svg><title>facebook</title></svg><svg><title>instagram</title></svg><a href="/story">A sufficiently important headline today</a>`
          }
        }),
        search: noSearch,
        ai: ai(),
        repo: repo()
      },
      { raw: "https://one.example", hasWebSearch: false }
    );
    expect(result).toMatchObject({
      status: "ok",
      candidates: [{ label: "The Atlantic" }]
    });
  });

  // Same bug, feed shape: a feed's channel title (the publication's name) is followed by one
  // title per story item. Adding the feed directly used to glue the channel name and every
  // headline together into one label.
  it("uses only a feed's channel title, not the headlines that follow it", async () => {
    const feedWithChannelAndItemTitles = `<rss><channel><title>Politico</title><item><title>A consequential headline today</title><link>https://one.example/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item><item><title>Another important headline today</title><link>https://one.example/story2</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
    const result = await resolveSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://one.example/feed.xml": {
            body: feedWithChannelAndItemTitles,
            contentType: "application/rss+xml"
          }
        }),
        search: noSearch,
        ai: ai(),
        repo: repo()
      },
      { raw: "https://one.example/feed.xml", hasWebSearch: false }
    );
    expect(result).toMatchObject({
      status: "ok",
      candidates: [{ label: "Politico" }]
    });
  });

  // Bug: a site can legitimately refuse automatic access through its own robots rules. That is a
  // deliberate policy choice by the site, not a sign the site is down, so it must be reported
  // separately from a real reachability problem.
  it("reports a site's own robots rules as blocked, not as unreachable", async () => {
    const robotsBlocked: NewsSafeFetchPort = async () => ({ ok: false, reason: "robots" });
    await expect(
      resolveSourceInput(
        db,
        { fetch: robotsBlocked, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "blocked" });

    const networkDown: NewsSafeFetchPort = async () => ({ ok: false, reason: "network" });
    await expect(
      resolveSourceInput(
        db,
        { fetch: networkDown, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "unreachable" });
  });

  // #1265 ALSO-1: same-host mutations that samePublisherIdentity can't catch on its own — the
  // hostname string is identical to the requested domain, so only normalizePublisherDomain's own
  // scheme/port/credentials checks (personalization-domain.ts) stand between this and acceptance.
  // A mutant that deleted those checks but kept samePublisherIdentity would still pass this suite
  // without this case.
  it("refuses a same-host redirect that downgrades to http, adds a port, or embeds credentials", async () => {
    const cases = [
      "http://publisher.example/",
      "https://publisher.example:8443/",
      "https://user:pass@publisher.example/"
    ];
    for (const finalUrl of cases) {
      const redirectsSameHost: NewsSafeFetchPort = async (url) => {
        if (url === "https://publisher.example/") {
          return {
            ok: true,
            status: 200,
            finalUrl,
            contentType: "text/html",
            body: "<title>publisher</title>",
            truncated: false
          };
        }
        throw new Error(`unexpected fetch: ${url}`);
      };

      await expect(
        resolveSourceInput(
          db,
          { fetch: redirectsSameHost, search: noSearch, ai: ai(), repo: repo() },
          { raw: "https://publisher.example", hasWebSearch: false }
        ),
        `finalUrl=${finalUrl}`
      ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
    }
  });
});
