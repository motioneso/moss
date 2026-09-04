import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { NewsAiPort } from "@moss/news";

import {
  resolveSportsSourceInput,
  type SportsSafeFetchPort
} from "../../packages/sports/src/source/discovery.js";
import {
  parseRedditListing,
  parseSubredditInput,
  readSubreddit,
  redditFailureReason,
  redditIconUrlFromAbout,
  redditPostToHeadline,
  sportsSourceIdentityKey
} from "../../packages/sports/src/source/reddit.js";

const db = {} as DataContextDb;
const ai = {} as NewsAiPort;

const ABOUT_URL = "https://www.reddit.com/r/nfl/about.json";
const ABOUT_URL_UPPER = "https://www.reddit.com/r/NFL/about.json";
const LISTING_URL = "https://www.reddit.com/r/nfl/new.json?limit=50";

const about = JSON.stringify({
  kind: "t5",
  data: {
    display_name: "nfl",
    title: "NFL: National Football League Discussion",
    public_description: "The place for NFL news.",
    community_icon:
      "https://styles.redditmedia.com/t5_2qmg3/styles/communityIcon_abc.png?width=256&amp;s=deadbeef",
    icon_img: ""
  }
});

function post(overrides: Record<string, unknown>) {
  return {
    kind: "t3",
    data: {
      id: "abc123",
      name: "t3_abc123",
      title: "Chiefs sign a new kicker",
      url: "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker",
      is_self: false,
      stickied: false,
      created_utc: 1_757_000_000,
      ...overrides
    }
  };
}

function listing(children: unknown[]) {
  return JSON.stringify({ kind: "Listing", data: { children } });
}

type FetchResult = Awaited<ReturnType<SportsSafeFetchPort>>;

function fetchMap(entries: Record<string, FetchResult>): SportsSafeFetchPort {
  return vi.fn(
    async (url: string): Promise<FetchResult> => entries[url] ?? { ok: false, reason: "network" }
  );
}

function okJson(url: string, body: string): FetchResult {
  return {
    ok: true,
    status: 200,
    finalUrl: url,
    contentType: "application/json",
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

describe("subreddit post filtering", () => {
  it("keeps a linked article and credits the registrable publisher domain", () => {
    expect(redditPostToHeadline(post({}).data)).toEqual({
      id: "t3_abc123",
      title: "Chiefs sign a new kicker",
      url: "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker",
      publishedAt: new Date(1_757_000_000 * 1000).toISOString(),
      publisherLabel: "espn.com",
      publisherDomain: "espn.com"
    });
  });

  it.each([
    ["self post", { is_self: true, url: "https://www.reddit.com/r/nfl/comments/abc123/x/" }],
    ["stickied post", { stickied: true }],
    ["image", { post_hint: "image", url: "https://i.redd.it/abc.png" }],
    ["video", { post_hint: "hosted:video", url: "https://v.redd.it/abc" }],
    ["reddit-internal link", { url: "https://www.reddit.com/r/other/comments/xyz/" }],
    ["short reddit link", { url: "https://redd.it/xyz" }],
    ["preview host", { url: "https://preview.redd.it/abc.jpg" }],
    ["crosspost", { crosspost_parent_list: [{ id: "parent" }] }],
    ["rich media hint", { post_hint: "rich:video", url: "https://www.youtube.com/watch?v=1" }],
    ["non-http link", { url: "ftp://files.example/report" }]
  ])("drops a %s", (_label, overrides) => {
    expect(redditPostToHeadline(post(overrides).data)).toBeNull();
  });

  it("caps a listing at forty linked articles and dedupes repeated links", () => {
    const children = Array.from({ length: 60 }, (_, index) =>
      post({
        id: `p${index}`,
        name: `t3_p${index}`,
        url: `https://news.example/story/${index % 50}`
      })
    );
    const parsed = parseRedditListing(listing(children));
    expect(parsed.ok && parsed.headlines).toHaveLength(40);
    expect(parseRedditListing(listing([post({}), post({})]))).toMatchObject({
      ok: true,
      headlines: [{ id: "t3_abc123" }]
    });
    expect(parseRedditListing('{"kind":"t5"}')).toEqual({ ok: false });
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
      feedUrl: "https://www.reddit.com/r/nfl/new.json?limit=50"
    });
    const upper = sportsSourceIdentityKey({
      retrievalMethod: "reddit",
      canonicalDomain: "reddit.com",
      feedUrl: "https://www.reddit.com/r/NFL/new.json?limit=50"
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

  it("strips the query and entities from the community icon and refuses foreign hosts", () => {
    expect(
      redditIconUrlFromAbout({
        community_icon:
          "https://styles.redditmedia.com/t5_x/styles/communityIcon_a.png?width=256&amp;s=1"
      })
    ).toBe("https://styles.redditmedia.com/t5_x/styles/communityIcon_a.png");
    expect(
      redditIconUrlFromAbout({
        community_icon: "",
        icon_img: "https://b.thumbs.redditmedia.com/x.png"
      })
    ).toBe("https://b.thumbs.redditmedia.com/x.png");
    expect(redditIconUrlFromAbout({ community_icon: "https://evil.example/icon.png" })).toBeNull();
    expect(
      redditIconUrlFromAbout({ community_icon: "http://styles.redditmedia.com/x.png" })
    ).toBeNull();
    expect(redditIconUrlFromAbout({})).toBeNull();
  });
});

describe("reading a subreddit", () => {
  it("pins both calls to www.reddit.com with JSON only, a byte cap, and a descriptive agent", async () => {
    const fetch = fetchMap({
      [ABOUT_URL_UPPER]: okJson(ABOUT_URL_UPPER, about),
      [LISTING_URL]: okJson(LISTING_URL, listing([post({})]))
    });
    const result = await readSubreddit(fetch, "NFL");
    expect(result).toMatchObject({
      ok: true,
      listingUrl: LISTING_URL,
      about: { displayName: "nfl", title: "NFL: National Football League Discussion" },
      headlines: [{ publisherDomain: "espn.com" }]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(fetch).mock.calls) {
      const options = call[1];
      expect(options?.allowedHosts).toEqual(["www.reddit.com"]);
      expect(options?.allowedContentTypes).toEqual(["application/json"]);
      expect(options?.maxBytes).toBe(1_000_000);
      expect(options?.rejectOversizedResponses).toBe(true);
      expect(options?.userAgent).toMatch(/^Moss\//);
      expect(options?.requestHeaders).toEqual({ accept: "application/json" });
      const guard = options?.beforeRequest;
      expect(await guard?.({ url: new URL(call[0]), redirectCount: 0 })).toBe(true);
      expect(
        await guard?.({ url: new URL("https://www.reddit.com/search?q=nfl"), redirectCount: 1 })
      ).toBe(false);
      expect(
        await guard?.({ url: new URL("https://old.reddit.com/r/nfl/about.json"), redirectCount: 0 })
      ).toBe(false);
    }
  });

  it("reports a missing subreddit whether Reddit answers 404 or a non-subreddit body", async () => {
    expect(
      await readSubreddit(
        fetchMap({ [ABOUT_URL]: { ok: false, reason: "http_error", status: 404 } }),
        "nfl"
      )
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await readSubreddit(
        fetchMap({ [ABOUT_URL]: okJson(ABOUT_URL, '{"kind":"Listing","data":{}}') }),
        "nfl"
      )
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("resolveSportsSourceInput for a subreddit", () => {
  const deps = () => ({
    fetch: fetchMap({
      [ABOUT_URL]: okJson(ABOUT_URL, about),
      [ABOUT_URL_UPPER]: okJson(ABOUT_URL_UPPER, about),
      [LISTING_URL]: okJson(
        LISTING_URL,
        listing([
          post({}),
          post({
            id: "self1",
            name: "t3_self1",
            is_self: true,
            url: "https://www.reddit.com/r/nfl/comments/self1/x/"
          }),
          post({
            id: "two",
            name: "t3_two",
            title: "Bills extend their coach",
            url: "https://theathletic.com/nfl/bills-coach"
          })
        ])
      )
    }),
    ai
  });

  it("builds a reddit candidate with the listing URL as the one target for every scope", async () => {
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
        feedUrl: LISTING_URL,
        retrievalMethod: "reddit",
        recipe: null,
        recipeFingerprint: null,
        iconUrl: "https://styles.redditmedia.com/t5_2qmg3/styles/communityIcon_abc.png",
        confirmedFetchHosts: ["www.reddit.com"],
        sampleCount: 2,
        samples: [
          { headline: "Chiefs sign a new kicker" },
          { headline: "Bills extend their coach" }
        ],
        targets: [
          { targetUrl: LISTING_URL, parameters: {} },
          { targetUrl: LISTING_URL, parameters: {} }
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
      { fetch: fetchMap({ [ABOUT_URL]: failure }), ai },
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
      rawUrl: LISTING_URL,
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
