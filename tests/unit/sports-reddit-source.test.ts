import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { NewsAiPort } from "@moss/news";

import {
  resolveSportsSourceInput,
  type SportsSafeFetchPort
} from "../../packages/sports/src/source/discovery.js";
import {
  parseRedditFeed,
  parseSubredditInput,
  readSubreddit,
  redditEntryToHeadline,
  redditFailureReason,
  sportsSourceIdentityKey
} from "../../packages/sports/src/source/reddit.js";

const db = {} as DataContextDb;
const ai = {} as NewsAiPort;

const FEED_URL = "https://www.reddit.com/r/nfl/hot.rss";
const FEED_URL_UPPER = "https://www.reddit.com/r/NFL/hot.rss";

interface EntryOverrides {
  readonly id?: string;
  readonly title?: string;
  readonly link?: string | null;
  readonly published?: string | null;
  readonly content?: string;
}

/** One Atom entry the way Reddit writes it: escaped HTML content ending in the [link] anchor. */
function entry(overrides: EntryOverrides = {}): string {
  const id = overrides.id ?? "t3_abc123";
  const title = overrides.title ?? "Chiefs sign a new kicker";
  const link =
    overrides.link === undefined
      ? "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker"
      : overrides.link;
  const thread = `https://www.reddit.com/r/nfl/comments/${id.slice(3)}/thread/`;
  const html =
    overrides.content ??
    `<!-- SC_OFF --><div class="md"><p>Body</p></div><!-- SC_ON --> submitted by <a href="https://www.reddit.com/user/fan"> /u/fan </a> <br/>` +
      (link === null ? "" : ` <span><a href="${link}">[link]</a></span>`) +
      ` <span><a href="${thread}">[comments]</a></span>`;
  const escaped = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const published =
    overrides.published === undefined ? "2025-09-04T14:13:20+00:00" : overrides.published;
  return (
    `<entry><author><name>/u/fan</name></author><category term="nfl" label="r/nfl"/>` +
    `<content type="html">${escaped}</content><id>${id}</id><link href="${thread}" />` +
    (published ? `<updated>${published}</updated><published>${published}</published>` : "") +
    `<title>${title}</title></entry>`
  );
}

function feed(entries: string[], head?: { term?: string; title?: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<category term="${head?.term ?? "nfl"}" label="r/${head?.term ?? "nfl"}"/>` +
    `<updated>2025-09-04T14:13:20+00:00</updated><icon>https://www.redditstatic.com/icon.png/</icon>` +
    `<id>/r/nfl/hot.rss</id><link rel="self" href="${FEED_URL}" type="application/atom+xml" />` +
    `<link rel="alternate" href="https://www.reddit.com/r/nfl/new" type="text/html" />` +
    `<subtitle>The place for NFL news.</subtitle>` +
    `<title>${head?.title ?? "NFL: National Football League Discussion"}</title>` +
    entries.join("") +
    `</feed>`
  );
}

type FetchResult = Awaited<ReturnType<SportsSafeFetchPort>>;

function fetchMap(entries: Record<string, FetchResult>): SportsSafeFetchPort {
  return vi.fn(
    async (url: string): Promise<FetchResult> => entries[url] ?? { ok: false, reason: "network" }
  );
}

function okAtom(url: string, body: string): FetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl: url,
    contentType: "application/atom+xml; charset=UTF-8",
    body,
    truncated: false
  };
}

describe("subreddit input detection", () => {
  it.each([
    ["r/nfl", "nfl"],
    ["/r/nfl", "nfl"],
    ["R/NFL/", "NFL"],
    ["https://www.reddit.com/r/LiverpoolFC", "LiverpoolFC"],
    ["https://old.reddit.com/r/CollegeBasketball/new/", "CollegeBasketball"],
    ["reddit.com/r/nfl?sort=new", "nfl"],
    ["https://www.reddit.com/r/nfl/comments/abc/some_post/", "nfl"]
  ])("accepts %s as subreddit %s", (raw, name) => {
    expect(parseSubredditInput(raw)).toEqual({ kind: "subreddit", name });
  });

  it.each(["r/ab", "r/this_name_is_far_too_long_for_reddit", "r/bad-name", "r/b.d"])(
    "flags %s as an invalid subreddit rather than a publication",
    (raw) => {
      expect(parseSubredditInput(raw)).toEqual({ kind: "invalid" });
    }
  );

  it.each([
    "theathletic.com",
    "https://one.example/feed.xml",
    "https://www.reddit.com/user/someone",
    "r",
    "r/"
  ])("leaves %s to the publication path", (raw) => {
    expect(parseSubredditInput(raw)).toBeNull();
  });
});

describe("subreddit entry filtering", () => {
  it("keeps a linked article and credits the registrable publisher domain", () => {
    expect(redditEntryToHeadline(entry())).toEqual({
      id: "t3_abc123",
      title: "Chiefs sign a new kicker",
      url: "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker",
      publishedAt: "2025-09-04T14:13:20.000Z",
      publisherLabel: "espn.com",
      publisherDomain: "espn.com"
    });
  });

  it("decodes entities in the outbound link and tolerates a missing date", () => {
    expect(
      redditEntryToHeadline(entry({ link: "https://news.example/story?a=1&b=2", published: null }))
    ).toMatchObject({ url: "https://news.example/story?a=1&b=2", publishedAt: null });
  });

  it.each([
    ["self post", { link: "https://www.reddit.com/r/nfl/comments/abc123/x/" }],
    ["entry without a [link] anchor", { link: null }],
    ["image", { link: "https://i.redd.it/abc.png" }],
    ["video", { link: "https://v.redd.it/abc" }],
    ["reddit-internal link", { link: "https://www.reddit.com/r/other/comments/xyz/" }],
    ["short reddit link", { link: "https://redd.it/xyz" }],
    ["preview host", { link: "https://preview.redd.it/abc.jpg" }],
    ["non-http link", { link: "ftp://files.example/report" }],
    ["entry with no title", { title: "" }]
  ])("drops a %s", (_label, overrides) => {
    expect(redditEntryToHeadline(entry(overrides))).toBeNull();
  });

  it("caps a feed at forty linked articles and dedupes repeated links", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({ id: `t3_p${index}`, link: `https://news.example/story/${index % 50}` })
    );
    const parsed = parseRedditFeed(feed(entries), "nfl");
    expect(parsed.ok && parsed.feed.headlines).toHaveLength(40);
    expect(parseRedditFeed(feed([entry(), entry()]), "nfl")).toMatchObject({
      ok: true,
      feed: { headlines: [{ id: "t3_abc123" }] }
    });
  });

  it("takes the subreddit's casing and title from the feed head, or the typed name", () => {
    expect(
      parseRedditFeed(feed([], { term: "LiverpoolFC", title: "Liverpool FC" }), "liverpoolfc")
    ).toEqual({
      ok: true,
      feed: {
        subreddit: {
          displayName: "LiverpoolFC",
          title: "Liverpool FC",
          description: "The place for NFL news.",
          iconUrl: null
        },
        headlines: []
      }
    });
    const noTerm = feed([]).replace(/<category[^>]*\/>/, "");
    expect(parseRedditFeed(noTerm, "nfl")).toMatchObject({
      ok: true,
      feed: { subreddit: { displayName: "nfl" } }
    });
  });

  it("refuses anything that is not an Atom feed", () => {
    expect(parseRedditFeed('{"kind":"Listing"}', "nfl")).toEqual({ ok: false });
    expect(parseRedditFeed("<html><body>blocked</body></html>", "nfl")).toEqual({ ok: false });
    expect(
      parseRedditFeed(
        '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>',
        "nfl"
      )
    ).toEqual({ ok: false });
  });
});

describe("subreddit failure mapping", () => {
  it.each([
    [{ reason: "http_error", status: 403 }, "auth_required"],
    [{ reason: "http_error", status: 401 }, "auth_required"],
    [{ reason: "http_error", status: 404 }, "not_found"],
    [{ reason: "http_error", status: 429 }, "rate_limited"],
    [{ reason: "rate_limited" }, "rate_limited"],
    [{ reason: "http_error", status: 503 }, "unreachable"],
    [{ reason: "network" }, "unreachable"],
    [{ reason: "timeout" }, "unreachable"],
    [{ reason: "blocked" }, "not_found"],
    [{ reason: "blocked", detail: "unsupported_content_type" }, "unreachable"]
  ])("maps %o to %s", (failure, expected) => {
    expect(redditFailureReason(failure)).toBe(expected);
  });
});

describe("subreddit identity and icon", () => {
  it("treats r/nfl and r/NFL as the same source and keeps publications by domain", () => {
    const lower = sportsSourceIdentityKey({
      retrievalMethod: "reddit",
      canonicalDomain: "reddit.com",
      feedUrl: "https://www.reddit.com/r/nfl/hot.rss"
    });
    const upper = sportsSourceIdentityKey({
      retrievalMethod: "reddit",
      canonicalDomain: "reddit.com",
      feedUrl: "https://www.reddit.com/r/NFL/hot.rss"
    });
    expect(lower).toBe(upper);
    expect(lower).toBe("reddit:nfl");
    expect(
      sportsSourceIdentityKey({
        retrievalMethod: "feed",
        canonicalDomain: "espn.com",
        feedUrl: null
      })
    ).toBe("domain:espn.com");
    expect(
      sportsSourceIdentityKey({
        retrievalMethod: "feed",
        canonicalDomain: "reddit.com",
        feedUrl: null
      })
    ).not.toBe(lower);
  });
});

describe("reading a subreddit", () => {
  it("makes one feed call pinned to www.reddit.com with Atom types, a byte cap, and a descriptive agent", async () => {
    const fetch = fetchMap({ [FEED_URL_UPPER]: okAtom(FEED_URL_UPPER, feed([entry()])) });
    const result = await readSubreddit(fetch, "NFL");
    expect(result).toMatchObject({
      ok: true,
      listingUrl: FEED_URL,
      subreddit: {
        displayName: "nfl",
        title: "NFL: National Football League Discussion",
        iconUrl: null
      },
      headlines: [{ publisherDomain: "espn.com" }]
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetch).mock.calls[0];
    const options = call?.[1];
    expect(options?.allowedHosts).toEqual(["www.reddit.com"]);
    expect(options?.allowedContentTypes).toEqual([
      "application/atom+xml",
      "application/rss+xml",
      "application/xml",
      "text/xml"
    ]);
    expect(options?.maxBytes).toBe(1_000_000);
    expect(options?.rejectOversizedResponses).toBe(true);
    expect(options?.userAgent).toMatch(/^Moss\//);
    expect(options?.requestHeaders?.accept).toMatch(/^application\/atom\+xml/);
    const guard = options?.beforeRequest;
    expect(await guard?.({ url: new URL(FEED_URL_UPPER), redirectCount: 0 })).toBe(true);
    expect(
      await guard?.({ url: new URL("https://www.reddit.com/search?q=nfl"), redirectCount: 1 })
    ).toBe(false);
    expect(
      await guard?.({ url: new URL("https://old.reddit.com/r/NFL/hot.rss"), redirectCount: 0 })
    ).toBe(false);
  });

  it("reports a missing subreddit whether Reddit answers 404 or a non-feed body", async () => {
    expect(
      await readSubreddit(
        fetchMap({ [FEED_URL]: { ok: false, reason: "http_error", status: 404 } }),
        "nfl"
      )
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await readSubreddit(fetchMap({ [FEED_URL]: okAtom(FEED_URL, "<html>blocked</html>") }), "nfl")
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("resolveSportsSourceInput for a subreddit", () => {
  const body = feed([
    entry(),
    entry({ id: "t3_self1", link: "https://www.reddit.com/r/nfl/comments/self1/x/" }),
    entry({
      id: "t3_two",
      title: "Bills extend their coach",
      link: "https://theathletic.com/nfl/bills-coach"
    })
  ]);
  const deps = () => ({
    fetch: fetchMap({
      [FEED_URL]: okAtom(FEED_URL, body),
      [FEED_URL_UPPER]: okAtom(FEED_URL_UPPER, body)
    }),
    ai
  });

  it("builds a reddit candidate with the feed URL as the one target for every scope", async () => {
    const result = await resolveSportsSourceInput(db, deps(), {
      rawUrl: "r/NFL",
      targets: [
        { target: { kind: "sport", sportKey: "football" }, label: "Football", scope: "sport" },
        {
          target: { kind: "follow", followId: "follow-1" },
          label: "Kansas City Chiefs",
          scope: "team"
        }
      ]
    });
    expect(result).toMatchObject({
      status: "ok",
      candidate: {
        label: "r/nfl",
        canonicalDomain: "reddit.com",
        homepageUrl: "https://www.reddit.com/r/nfl/",
        feedUrl: FEED_URL,
        retrievalMethod: "reddit",
        recipe: null,
        recipeFingerprint: null,
        iconUrl: null,
        confirmedFetchHosts: ["www.reddit.com"],
        sampleCount: 2,
        samples: [
          { headline: "Chiefs sign a new kicker" },
          { headline: "Bills extend their coach" }
        ],
        targets: [
          { targetUrl: FEED_URL, parameters: {} },
          { targetUrl: FEED_URL, parameters: {} }
        ]
      }
    });
  });

  it.each([
    ["not_found", { ok: false, reason: "http_error", status: 404 }],
    ["auth_required", { ok: false, reason: "http_error", status: 403 }],
    ["rate_limited", { ok: false, reason: "http_error", status: 429 }],
    ["unreachable", { ok: false, reason: "http_error", status: 502 }]
  ] as const)("rejects with %s", async (reason, failure) => {
    const result = await resolveSportsSourceInput(
      db,
      { fetch: fetchMap({ [FEED_URL]: failure }), ai },
      { rawUrl: "r/nfl" }
    );
    expect(result).toEqual({ status: "rejected", reason });
  });

  it("rejects a malformed name without fetching", async () => {
    const fetch = fetchMap({});
    expect(await resolveSportsSourceInput(db, { fetch, ai }, { rawUrl: "r/no" })).toEqual({
      status: "rejected",
      reason: "invalid_input"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a saved row whose authority is not reddit pinned to www.reddit.com", async () => {
    const result = await resolveSportsSourceInput(db, deps(), {
      rawUrl: FEED_URL,
      persistedAuthority: {
        canonicalDomain: "reddit.com",
        recipeJson: null,
        recipeFingerprint: null,
        confirmedFetchHosts: ["old.reddit.com"]
      }
    });
    expect(result).toEqual({ status: "rejected", reason: "unsupported" });
  });
});
