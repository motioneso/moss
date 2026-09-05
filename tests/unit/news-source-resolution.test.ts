import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import type { NewsAiPort, NewsSafeFetchPort } from "../../packages/news/src/discovery/ports.js";
import {
  isKnownSameOwnerAlias,
  resolveSourceInput
} from "../../packages/news/src/discovery/source-resolution.js";

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

// Same as ai(), but generateJson is a spy so a test can prove the model was never asked.
function aiSpy(allowed = true): NewsAiPort & { generateJson: ReturnType<typeof vi.fn> } {
  const generateJson = vi.fn<NewsAiPort["generateJson"]>(async () => ({
    ok: true,
    object: { allowed, category: "news_publisher" }
  }));
  return { fingerprint: async () => "fp", generateJson };
}

function repo(exclusions: string[] = [], cachedVerdict: "approved" | "rejected" | null = null) {
  return {
    listExclusions: vi.fn(async () =>
      exclusions.map((canonicalDomain) => ({ id: canonicalDomain, canonicalDomain, createdAt: "" }))
    ),
    readPolicyVerdict: vi.fn(async () => cachedVerdict),
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

describe("isKnownSameOwnerAlias", () => {
  const groups = [["old.example", "new.example"], ["another.example"]];

  it("matches two domains placed in the same hand-confirmed group, in either order", () => {
    expect(isKnownSameOwnerAlias(groups, "old.example", "new.example")).toBe(true);
    expect(isKnownSameOwnerAlias(groups, "new.example", "old.example")).toBe(true);
  });

  it("also matches a subdomain of a group member", () => {
    expect(isKnownSameOwnerAlias(groups, "www.old.example", "new.example")).toBe(true);
  });

  it("does not match domains from different groups, or an empty group list", () => {
    expect(isKnownSameOwnerAlias(groups, "old.example", "another.example")).toBe(false);
    expect(isKnownSameOwnerAlias([], "old.example", "new.example")).toBe(false);
  });
});

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
        { fetch, search: noSearch, ai: ai(), repo: repo([], "approved") },
        { raw: "https://one.example/article", hasWebSearch: false }
      )
    ).resolves.toMatchObject({
      status: "ok",
      candidates: [{ homepageUrl: "https://one.example/" }]
    });
    expect(fetch).toHaveBeenCalledWith("https://one.example/");
  });

  // Regression for review round 3, blocker 1: sending a specific page to its own homepage is
  // still a move, even with no domain change, so it must skip the model call the same way a
  // cross-domain move does. On the old code this reached the model (no saved decision, so the
  // request would have failed here) instead of reading the previously saved decision.
  it("takes a page-to-homepage move through the model-free path, using only a saved decision", async () => {
    const fetch = fetchMap({
      "https://one.example/article": {
        body: `<link rel="canonical" href="https://one.example/canonical-story">`
      },
      "https://one.example/": {
        body: `<title>One News</title><a href="/story">A sufficiently important headline today</a>`
      }
    });
    const spiedAi = aiSpy();
    const result = await resolveSourceInput(
      db,
      { fetch, search: noSearch, ai: spiedAi, repo: repo([], "approved") },
      { raw: "https://one.example/article", hasWebSearch: false }
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(spiedAi.generateJson).not.toHaveBeenCalled();
    if (result.status === "ok") {
      expect(result.candidates[0].redirectNote).not.toBeNull();
    }

    // With no saved decision at all, the model-free rule means the address reads as
    // unavailable rather than asking the model — proof the model call was truly skipped, not
    // just cached.
    await expect(
      resolveSourceInput(
        db,
        { fetch, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://one.example/article", hasWebSearch: false }
      )
    ).resolves.toEqual({ status: "unavailable" });
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

  // A page describing itself as its own address is not proof it is owned by the site the user
  // typed. Before this fix, any final site that labeled itself correctly was accepted — so a
  // publisher's own open-redirect link could be pointed at a completely unrelated site and Moss
  // would offer that unrelated site as the "real" publisher. This must now be refused.
  it("refuses a cross-domain redirect to an unrelated site, even if that site claims itself", async () => {
    const redirectsToUnrelatedSite: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://new.example/",
          hopCount: 1,
          contentType: "text/html",
          body: `<title>New Example</title><link rel="canonical" href="https://new.example/"><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsToUnrelatedSite, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  // Same open-redirect shape as above, but with no self-claiming tag at all — confirms the
  // refusal does not depend on what the destination page says about itself.
  it("refuses a cross-domain redirect to an unrelated site with no self-claim either", async () => {
    const redirectsToUnrelatedSite: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://new.example/",
          hopCount: 1,
          contentType: "text/html",
          body: `<a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsToUnrelatedSite, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  // A shortener disguised behind the usual "www" prefix must still be caught — the old code
  // matched the shortener set by exact domain string only.
  it("rejects a redirect to a link shortener even behind a www prefix", async () => {
    const redirectsToWwwShortener: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://www.bit.ly/abc123",
          hopCount: 1,
          contentType: "text/html",
          body: `<title>Redirect</title><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsToWwwShortener, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  it("rejects a redirect to a known link shortener", async () => {
    const redirectsToShortener: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://bit.ly/abc123",
          hopCount: 1,
          contentType: "text/html",
          body: `<title>Redirect</title><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsToShortener, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  it("rejects a redirect whose own canonical link points to yet another domain", async () => {
    const redirectsThenClaimsElsewhere: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://new.example/",
          hopCount: 1,
          contentType: "text/html",
          body: `<link rel="canonical" href="https://third.example/"><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch: redirectsThenClaimsElsewhere, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });

  // Regression for review round 3, blockers 1 and 3: a same-domain www move is a real move, so
  // it must carry a note naming the switch and skip the model call. On the old code this had no
  // note (readable as "nothing changed") and still asked the model.
  it("resolves a same-domain www move with a note naming the switch, and no model call", async () => {
    const wwwRedirect: NewsSafeFetchPort = async (url) => {
      if (url === "https://example.com/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://www.example.com/",
          hopCount: 1,
          contentType: "text/html",
          body: `<title>Example</title><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const spiedAi = aiSpy();
    const result = await resolveSourceInput(
      db,
      { fetch: wwwRedirect, search: noSearch, ai: spiedAi, repo: repo([], "approved") },
      { raw: "https://example.com", hasWebSearch: false }
    );
    expect(result).toMatchObject({
      status: "ok",
      candidates: [{ canonicalDomain: "www.example.com" }]
    });
    expect(spiedAi.generateJson).not.toHaveBeenCalled();
    if (result.status === "ok") {
      expect(result.candidates[0].redirectNote).toBe(
        "example.com sends visitors to www.example.com, so that is the site we will follow."
      );
    }

    // With no saved decision, the model-free rule reads this as unavailable rather than
    // reaching for the model — proof the old code's model call is really gone.
    await expect(
      resolveSourceInput(
        db,
        { fetch: wwwRedirect, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://example.com", hasWebSearch: false }
      )
    ).resolves.toEqual({ status: "unavailable" });
  });

  // Regression for review round 3, blocker 2: once a same-site redirect is accepted, the page
  // can still name a completely unrelated site as its "real" homepage. The ownership check on
  // that second move must be against the domain the user actually typed, not against the
  // unrelated site's own claim about itself (which always trivially matches). On the old code
  // this was accepted as "ok".
  it("checks a same-site page's declared homepage against the domain the user typed, not against itself", async () => {
    const fetch: NewsSafeFetchPort = async (url) => {
      if (url === "https://old.example/article") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://old.example/article",
          contentType: "text/html",
          body: `<link rel="canonical" href="https://unrelated.example/">`,
          truncated: false
        };
      }
      if (url === "https://unrelated.example/") {
        return {
          ok: true,
          status: 200,
          finalUrl: "https://unrelated.example/",
          contentType: "text/html",
          body: `<title>Unrelated</title><a href="/story">A sufficiently important headline today</a>`,
          truncated: false
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(
      resolveSourceInput(
        db,
        { fetch, search: noSearch, ai: ai(), repo: repo() },
        { raw: "https://old.example/article", hasWebSearch: false }
      )
    ).resolves.toMatchObject({ status: "rejected", reason: "redirected" });
  });
});
