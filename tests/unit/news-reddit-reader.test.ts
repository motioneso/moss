/**
 * #2282 The shared subreddit reader now lives in @moss/news. These cases moved from
 * tests/unit/sports-reddit-source.test.ts unchanged in intent; Sports keeps only its own identity
 * and candidate-mapping cases there.
 */
import { describe, expect, it, vi } from "vitest";

import {
  parseRedditFeed,
  parseSubredditInput,
  readSubreddit,
  redditEntryToHeadline,
  redditFailureReason,
  redditFetchOptions,
  redditHotFeedUrl,
  redditSubredditUrl,
  subredditNameFromUrl,
  type RedditFetchPort,
  type RedditFetchResult
} from "../../packages/news/src/source/reddit-reader.js";

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
export function redditEntry(overrides: EntryOverrides = {}): string {
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

export function redditFeed(entries: string[], head?: { term?: string; title?: string }): string {
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

function fetchMap(entries: Record<string, RedditFetchResult>): RedditFetchPort {
  return vi.fn(
    async (url: string): Promise<RedditFetchResult> =>
      entries[url] ?? { ok: false, reason: "network" }
  );
}

function okAtom(url: string, body: string): RedditFetchResult {
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

  it("builds the homepage and hot feed URLs and reads the name back out of them", () => {
    expect(redditSubredditUrl("NFL")).toBe("https://www.reddit.com/r/NFL/");
    expect(redditHotFeedUrl("NFL")).toBe(FEED_URL_UPPER);
    expect(subredditNameFromUrl(FEED_URL_UPPER)).toBe("NFL");
    expect(subredditNameFromUrl("https://espn.com/nfl")).toBeNull();
    expect(subredditNameFromUrl(null)).toBeNull();
  });
});

describe("subreddit entry filtering", () => {
  it("keeps a linked article and credits the publisher domain without www", () => {
    expect(redditEntryToHeadline(redditEntry())).toEqual({
      id: "t3_abc123",
      title: "Chiefs sign a new kicker",
      url: "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker",
      publishedAt: "2025-09-04T14:13:20.000Z",
      publisherLabel: "espn.com",
      publisherDomain: "espn.com"
    });
  });

  it("lets the caller supply its own publisher domain rule", () => {
    const link = "https://news.bbc.co.uk/sport/1";
    expect(redditEntryToHeadline(redditEntry({ link }))).toMatchObject({
      publisherDomain: "news.bbc.co.uk"
    });
    expect(
      redditEntryToHeadline(redditEntry({ link }), { publisherDomain: () => "bbc.co.uk" })
    ).toMatchObject({ publisherLabel: "bbc.co.uk", publisherDomain: "bbc.co.uk" });
    expect(
      redditEntryToHeadline(redditEntry({ link }), { publisherDomain: () => "reddit.com" })
    ).toBeNull();
  });

  it("decodes entities in the outbound link and tolerates a missing date", () => {
    expect(
      redditEntryToHeadline(
        redditEntry({ link: "https://news.example/story?a=1&b=2", published: null })
      )
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
    expect(redditEntryToHeadline(redditEntry(overrides))).toBeNull();
  });

  it("caps a feed at forty linked articles and dedupes repeated links", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      redditEntry({ id: `t3_p${index}`, link: `https://news.example/story/${index % 50}` })
    );
    const parsed = parseRedditFeed(redditFeed(entries), "nfl");
    expect(parsed.ok && parsed.feed.headlines).toHaveLength(40);
    expect(parseRedditFeed(redditFeed([redditEntry(), redditEntry()]), "nfl")).toMatchObject({
      ok: true,
      feed: { headlines: [{ id: "t3_abc123" }] }
    });
    const capped = parseRedditFeed(redditFeed(entries), "nfl", { limit: 10 });
    expect(capped.ok && capped.feed.headlines).toHaveLength(10);
  });

  it("takes the subreddit's casing and title from the feed head, or the typed name", () => {
    expect(
      parseRedditFeed(redditFeed([], { term: "LiverpoolFC", title: "Liverpool FC" }), "liverpoolfc")
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
    const noTerm = redditFeed([]).replace(/<category[^>]*\/>/, "");
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

describe("reading a subreddit", () => {
  it("makes one feed call pinned to www.reddit.com with Atom types, a byte cap, a descriptive agent, and no robots gate", async () => {
    const fetch = fetchMap({
      [FEED_URL_UPPER]: okAtom(FEED_URL_UPPER, redditFeed([redditEntry()]))
    });
    const result = await readSubreddit(fetch, "NFL");
    expect(result).toMatchObject({
      ok: true,
      feedUrl: FEED_URL,
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
    expect(options?.skipRobots).toBe(true);
    expect(options?.userAgent).toMatch(/^Moss\//);
    expect(options?.requestHeaders?.accept).toMatch(/^application\/atom\+xml/);
    const guard = options?.beforeRequest;
    expect(guard?.({ url: new URL(FEED_URL_UPPER), redirectCount: 0 })).toBe(true);
    expect(guard?.({ url: new URL("https://www.reddit.com/search?q=nfl"), redirectCount: 1 })).toBe(
      false
    );
    expect(
      guard?.({ url: new URL("https://old.reddit.com/r/NFL/hot.rss"), redirectCount: 0 })
    ).toBe(false);
    expect(
      guard?.({ url: new URL("https://www.reddit.com:8443/r/NFL/hot.rss"), redirectCount: 0 })
    ).toBe(false);
  });

  it("passes a timeout and abort signal through when asked", () => {
    const controller = new AbortController();
    const options = redditFetchOptions(FEED_URL, { timeoutMs: 6_000, signal: controller.signal });
    expect(options.timeoutMs).toBe(6_000);
    expect(options.signal).toBe(controller.signal);
    expect(redditFetchOptions(FEED_URL)).not.toHaveProperty("timeoutMs");
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

  it.each([
    ["auth_required", { ok: false, reason: "http_error", status: 403 }],
    ["rate_limited", { ok: false, reason: "http_error", status: 429 }],
    ["unreachable", { ok: false, reason: "network" }]
  ] as const)("surfaces %s from the feed call", async (reason, failure) => {
    expect(await readSubreddit(fetchMap({ [FEED_URL]: failure }), "nfl")).toEqual({
      ok: false,
      reason
    });
  });
});
