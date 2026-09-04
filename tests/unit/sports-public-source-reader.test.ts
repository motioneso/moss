import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import { isPublicFeedDocument } from "@moss/news";

import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import {
  SPORTS_PHOTO_DEADLINE_MARGIN_MS,
  SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS,
  type EnsurePhotoResult,
  type SportsPhotoStore
} from "../../packages/sports/src/source/photo-store.js";
import { SportsPublicSourceReader } from "../../packages/sports/src/source/public-source-reader.js";
import { validateSportsSourceRecipe } from "../../packages/sports/src/source/recipe.js";
import type {
  SportsRuntimeSource,
  SportsRuntimeTargetResult,
  SportsSourcesRepository
} from "../../packages/sports/src/source/repository.js";
import type { SportsNewsScope } from "../../packages/sports/src/source/scope.js";

const actor: AccessContext = { actorUserId: "user-a", requestId: "request-a" };

/** Mirrors the reader's own refresh deadline, which it does not export. */
const REFRESH_DEADLINE_MS = 12_000;

const jsonRecipe = {
  version: 1,
  kind: "json",
  fetchHosts: ["api.publisher.example"],
  request: {
    urlTemplate: "https://api.publisher.example/team/{teamId}/news",
    slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 32 }],
    headers: { accept: "application/json" }
  },
  scopes: ["team"],
  itemLimit: 10,
  extraction: {
    itemsPath: ["news"],
    headlinePath: ["title"],
    urlPath: ["url"],
    publishedAtPath: ["publishedAt"],
    normalize: ["trim", "collapse_whitespace", "strip_controls"]
  }
} as const;

const htmlRecipe = {
  version: 1,
  kind: "html",
  fetchHosts: ["www.publisher.example"],
  request: {
    urlTemplate: "https://www.publisher.example/team/{teamId}/news",
    slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 32 }],
    headers: { accept: "text/html,application/xhtml+xml" }
  },
  scopes: ["team"],
  itemLimit: 10,
  extraction: {
    collectionSelector: "main.news",
    itemSelector: "article.story",
    headline: { selector: "h2", source: "text" },
    url: { selector: "a", source: "attribute", attribute: "href" },
    normalize: ["trim", "collapse_whitespace", "strip_controls"]
  }
} as const;

function fingerprint(recipe: Readonly<Record<string, unknown>>): string {
  const result = validateSportsSourceRecipe(recipe);
  if (!result.ok) throw new Error(result.reason);
  return result.fingerprint;
}

function runtimeSource(options: {
  id: string;
  recipe?: Readonly<Record<string, unknown>> | null;
  parameters?: Readonly<Record<string, unknown>>;
  targetUrl?: string | null;
  feedUrl?: string | null;
  hosts?: readonly string[];
  fingerprint?: string;
  scope?: SportsNewsScope;
}): SportsRuntimeSource {
  const recipe = options.recipe === undefined ? jsonRecipe : options.recipe;
  return {
    id: options.id,
    label: `Publisher ${options.id}`,
    canonicalDomain: "publisher.example",
    feedUrl: options.feedUrl ?? null,
    retrievalMethod: options.feedUrl ? "feed" : "scrape",
    enabled: true,
    runtimeFingerprint:
      options.fingerprint ?? (recipe === null ? `legacy-${options.id}` : fingerprint(recipe)),
    recipeJson: recipe,
    confirmedFetchHosts:
      options.hosts ??
      (recipe && Array.isArray(recipe.fetchHosts) ? (recipe.fetchHosts as string[]) : []),
    assignments: [
      {
        id: `assignment-${options.id}`,
        scope: options.scope ?? {
          kind: "team",
          sportKey: "soccer",
          competitionKey: "eng.1",
          teamKey: "arsenal"
        },
        targetUrl: options.targetUrl ?? `https://publisher.example/display/${options.id}`,
        targetParameters: options.parameters ?? { teamId: options.id },
        previewStatus: "verified"
      }
    ]
  };
}

function success(
  finalUrl: string,
  body: string,
  contentType = "application/json"
): Awaited<ReturnType<SportsSafeFetchPort>> {
  return { ok: true, status: 200, finalUrl, contentType, body, truncated: false };
}

function makeReader(
  sources: readonly SportsRuntimeSource[],
  fetch: SportsSafeFetchPort,
  options: {
    now?: () => number;
    sleep?: () => Promise<void>;
    photos?: PhotoStoreDouble;
  } = {}
) {
  const persisted: SportsRuntimeTargetResult[][] = [];
  const repository = {
    listRuntimeSources: vi.fn(async () => [...sources]),
    persistRuntimeResults: vi.fn(
      async (_db: DataContextDb, results: SportsRuntimeTargetResult[]) => {
        persisted.push([...results]);
        return results.length;
      }
    )
  } as unknown as SportsSourcesRepository;
  const reader = new SportsPublicSourceReader({
    dataContext: {
      withDataContext: async <T>(
        _accessContext: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => work({} as DataContextDb)
    },
    repository,
    fetch,
    now: options.now,
    sleep: options.sleep,
    ...(options.photos ? { photos: options.photos as unknown as SportsPhotoStore } : {})
  });
  return { reader, repository, persisted };
}

/**
 * #2237 stands in for the vault-backed photo store: it records every photo URL it was asked to
 * store, so a test can assert which candidate the reader chose without touching a filesystem.
 */
class PhotoStoreDouble {
  readonly stored: string[] = [];
  readonly budgets: number[] = [];
  readonly links = new Map<string, string>();
  swept: ReadonlySet<string> | null = null;
  /** Set to make every download attempt fail, as a permanently broken image would. */
  alwaysFails = false;
  /** Called with the time the download was allowed, so a test can make one really take that long. */
  onDownload: ((allowedMs: number) => Promise<void>) | null = null;

  async ensure(
    _access: AccessContext,
    sourceId: string,
    photoUrl: string,
    options: {
      readonly signal?: AbortSignal;
      readonly remainingMs?: () => number;
    } = {}
  ): Promise<EnsurePhotoResult> {
    // Mirrors the real store: the safety margin is applied to the time left at the moment the
    // download would start, and the download is capped at the store's own limit.
    const remaining = options.remainingMs?.() ?? SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS;
    if (remaining <= SPORTS_PHOTO_DEADLINE_MARGIN_MS) return { outcome: "skipped" };
    const allowed = Math.min(SPORTS_PHOTO_DOWNLOAD_TIMEOUT_MS, remaining);
    this.stored.push(photoUrl);
    this.budgets.push(allowed);
    await this.onDownload?.(allowed);
    if (this.alwaysFails) return { outcome: "unusable" };
    return {
      outcome: "stored",
      photo: { key: `key-${this.stored.length}`, width: 1280, height: 720, bytes: 4096 }
    };
  }

  linkHeadline(actorUserId: string, headlineId: string, key: string): void {
    this.links.set(`${actorUserId} ${headlineId}`, key);
  }

  async sweep(_access: AccessContext, keepKeys: ReadonlySet<string>) {
    this.swept = keepKeys;
    return { removed: 0 };
  }
}

async function permitInitialRequest(
  url: string,
  options: Parameters<SportsSafeFetchPort>[1]
): Promise<boolean> {
  return (await options?.beforeRequest?.({ url: new URL(url), redirectCount: 0 })) !== false;
}

describe("SportsPublicSourceReader", () => {
  it("extracts RSS, JSON, and HTML without fetching article or pagination links", async () => {
    const sources = [
      runtimeSource({
        id: "feed",
        recipe: null,
        feedUrl: "https://feeds.publisher.example/sports.xml",
        hosts: ["feeds.publisher.example"]
      }),
      runtimeSource({ id: "json", parameters: { teamId: "8650" } }),
      runtimeSource({ id: "html", recipe: htmlRecipe, parameters: { teamId: "arsenal" } })
    ];
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        expect(options?.allowedContentTypes).toContain("text/plain");
        return success(
          url,
          `<rss><channel><item><guid>feed-1</guid><title> Feed  story </title><link>https://stories.example/feed</link></item></channel></rss>`,
          "text/plain"
        );
      }
      if (url.includes("/team/8650/")) {
        return success(
          url,
          JSON.stringify({
            news: [
              {
                title: " JSON   story ",
                url: "https://stories.example/json",
                publishedAt: "2026-08-24T12:00:00Z"
              }
            ]
          })
        );
      }
      return success(
        url,
        `<main class="news"><article class="story"><a href="https://stories.example/html"><h2> HTML story </h2></a></article></main>`,
        "text/html"
      );
    });
    const { reader, persisted } = makeReader(sources, fetch);

    const result = await reader.refresh(actor);

    expect(result.headlines.map((item) => item.title).sort()).toEqual([
      "Feed story",
      "HTML story",
      "JSON story"
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toHaveLength(3);
    expect(fetch.mock.calls.flatMap(([url]) => url)).not.toContain("stories.example");
    expect(persisted[0]).toHaveLength(3);
    expect(persisted[0]?.every((item) => item.healthState === "healthy")).toBe(true);
  });

  it("emits a sport assignment once without fake competition or team attribution", async () => {
    const source = runtimeSource({
      id: "soccer",
      recipe: null,
      feedUrl: "https://feeds.publisher.example/soccer.xml",
      hosts: ["feeds.publisher.example"],
      scope: { kind: "sport", sportKey: "soccer" }
    });
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return success(
        url,
        `<rss><channel><item><guid>general-1</guid><title>Soccer story</title><link>https://stories.example/general</link></item></channel></rss>`,
        "application/rss+xml"
      );
    });
    const { reader, persisted } = makeReader([source], fetch);

    const result = await reader.refresh(actor);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.headlines).toEqual([
      expect.objectContaining({
        sportKey: "soccer",
        competitionKey: null,
        competitionLabel: "Soccer",
        teamKeys: []
      })
    ]);
    expect(persisted[0]).toHaveLength(1);
  });

  it("fetches one source request once for sport and follow scopes while persisting both", async () => {
    const base = runtimeSource({
      id: "shared-soccer",
      recipe: null,
      feedUrl: "https://feeds.publisher.example/soccer.xml",
      hosts: ["feeds.publisher.example"],
      scope: { kind: "sport", sportKey: "soccer" }
    });
    const source: SportsRuntimeSource = {
      ...base,
      assignments: [
        base.assignments[0]!,
        {
          ...base.assignments[0]!,
          id: "assignment-shared-soccer-team",
          scope: {
            kind: "team",
            sportKey: "soccer",
            competitionKey: "eng.1",
            teamKey: "arsenal"
          }
        }
      ]
    };
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return success(
        url,
        `<rss><channel><item><guid>shared-1</guid><title>Shared story</title><link>https://stories.example/shared</link></item></channel></rss>`,
        "application/rss+xml"
      );
    });
    const { reader, persisted } = makeReader([source], fetch);

    const result = await reader.refresh(actor);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.headlines.map(({ competitionKey }) => competitionKey)).toEqual([null, "eng.1"]);
    expect(persisted[0]).toEqual([
      expect.objectContaining({
        assignmentId: "assignment-shared-soccer",
        healthState: "healthy"
      }),
      expect.objectContaining({
        assignmentId: "assignment-shared-soccer-team",
        healthState: "healthy"
      })
    ]);
  });

  it("treats valid-empty feed and recipe collections as healthy, but missing structure as drift", async () => {
    const sources = [
      runtimeSource({
        id: "empty-feed",
        recipe: null,
        feedUrl: "https://feeds.publisher.example/empty.xml",
        hosts: ["feeds.publisher.example"]
      }),
      runtimeSource({ id: "empty-json", parameters: { teamId: "empty" } }),
      runtimeSource({ id: "drift-json", parameters: { teamId: "drift" } })
    ];
    const fetch: SportsSafeFetchPort = async (url, options) => {
      await permitInitialRequest(url, options);
      if (url.endsWith("empty.xml")) {
        return success(url, `<rss><channel></channel></rss>`, "application/rss+xml");
      }
      return success(url, url.includes("/empty/") ? `{"news":[]}` : `{}`);
    };
    const { reader, persisted } = makeReader(sources, fetch);

    await reader.refresh(actor);

    expect(
      persisted[0]?.map((item) => [item.assignmentId, item.healthState, item.healthReasonCode])
    ).toEqual([
      ["assignment-empty-feed", "healthy", null],
      ["assignment-empty-json", "healthy", null],
      ["assignment-drift-json", "failing", "recipe_drift"]
    ]);
  });

  it("persists stable no-check failures for missing, invalid, drifted, and unexpandable recipes", async () => {
    const validFingerprint = fingerprint(jsonRecipe);
    const sources = [
      runtimeSource({ id: "missing", recipe: null, fingerprint: "missing-fingerprint" }),
      runtimeSource({
        id: "invalid",
        recipe: { executable: "fetch('/private')" },
        fingerprint: "invalid-fingerprint"
      }),
      runtimeSource({ id: "fingerprint", fingerprint: "obsolete" }),
      runtimeSource({
        id: "parameters",
        parameters: { wrong: "value" },
        fingerprint: validFingerprint
      })
    ];
    const fetch = vi.fn<SportsSafeFetchPort>();
    const { reader, persisted } = makeReader(sources, fetch);

    const result = await reader.refresh(actor);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(persisted[0]?.map((item) => [item.healthReasonCode, item.checkedAt])).toEqual([
      ["recipe_missing", null],
      ["recipe_drift", null],
      ["recipe_drift", null],
      ["invalid_target", null]
    ]);
  });

  it("leaves pending assignments untouched and out of runtime degradation", async () => {
    const verified = runtimeSource({ id: "pending", parameters: { teamId: "8650" } });
    const source: SportsRuntimeSource = {
      ...verified,
      assignments: verified.assignments.map((assignment) => ({
        ...assignment,
        previewStatus: "pending"
      }))
    };
    const fetch = vi.fn<SportsSafeFetchPort>();
    const { reader, repository } = makeReader([source], fetch);

    await expect(reader.refresh(actor)).resolves.toEqual({
      headlines: [],
      degraded: false,
      persistedResults: 0
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.persistRuntimeResults).not.toHaveBeenCalled();
  });

  it("serves fresh cache without manufacturing health and serves stale content with the real failure", async () => {
    let now = 1_000;
    let fail = false;
    const source = runtimeSource({ id: "cache", parameters: { teamId: "8650" } });
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return fail
        ? { ok: false, reason: "network" }
        : success(url, `{"news":[{"title":"Cached story","url":"https://stories.example/1"}]}`);
    });
    const { reader, repository, persisted } = makeReader([source], fetch, { now: () => now });

    const first = await reader.refresh(actor);
    now += 1;
    const fresh = await reader.refresh(actor);
    expect(fresh.headlines).toEqual(first.headlines);
    expect(fresh.headlines[0]?.publishedAt).toBe(new Date(1_000).toISOString());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(repository.persistRuntimeResults).toHaveBeenCalledTimes(1);

    now += 10 * 60 * 1000;
    fail = true;
    const stale = await reader.refresh(actor);
    expect(stale.headlines).toHaveLength(1);
    expect(stale.degraded).toBe(true);
    expect(persisted[1]?.[0]).toMatchObject({ healthState: "failing", checkedAt: new Date(now) });
  });

  it("shares equal expanded requests while keeping different opaque parameters separate", async () => {
    const sharedA = runtimeSource({ id: "shared-a", parameters: { teamId: "8650" } });
    const sharedB = runtimeSource({ id: "shared-b", parameters: { teamId: "8650" } });
    const distinct = runtimeSource({
      id: "distinct",
      parameters: { teamId: "9825" },
      targetUrl: sharedA.assignments[0]?.targetUrl
    });
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return success(url, `{"news":[]}`);
    });
    const { reader, persisted } = makeReader([sharedA, sharedB, distinct], fetch);

    await reader.refresh(actor);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(persisted[0]).toHaveLength(3);
  });

  it("counts redirect hops against the request budget and does not manufacture a check", async () => {
    const fetch: SportsSafeFetchPort = async (url, options) => {
      for (let redirectCount = 0; redirectCount < 31; redirectCount += 1) {
        const allowed = await options?.beforeRequest?.({ url: new URL(url), redirectCount });
        if (allowed === false) return { ok: false, reason: "blocked" };
      }
      throw new Error("request budget was not enforced");
    };
    const { reader, persisted } = makeReader(
      [runtimeSource({ id: "redirect-budget", parameters: { teamId: "8650" } })],
      fetch
    );

    await reader.refresh(actor);

    expect(persisted[0]?.[0]).toMatchObject({
      healthReasonCode: "request_budget_exceeded",
      checkedAt: null
    });
  });

  it("retries one bounded 429 once and bypasses a fresh cache on explicit retry", async () => {
    let calls = 0;
    const fetch: SportsSafeFetchPort = async (url, options) => {
      calls += 1;
      await permitInitialRequest(url, options);
      if (calls === 1) return { ok: false, reason: "http_error", status: 429, retryAfter: "0" };
      return success(url, `{"news":[{"title":"Recovered"}]}`);
    };
    const { reader, repository } = makeReader(
      [runtimeSource({ id: "retry", parameters: { teamId: "8650" } })],
      fetch,
      { sleep: async () => {} }
    );

    await reader.refresh(actor);
    await reader.refresh(actor, { bypassCache: true });

    expect(calls).toBe(3);
    expect(repository.persistRuntimeResults).toHaveBeenCalledTimes(2);
  });

  it("keeps sibling targets usable when one target fails", async () => {
    const fetch: SportsSafeFetchPort = async (url, options) => {
      await permitInitialRequest(url, options);
      return url.includes("/bad/")
        ? { ok: false, reason: "network" }
        : success(url, `{"news":[{"title":"Good story"}]}`);
    };
    const { reader, persisted } = makeReader(
      [
        runtimeSource({ id: "good", parameters: { teamId: "good" } }),
        runtimeSource({ id: "bad", parameters: { teamId: "bad" } })
      ],
      fetch
    );

    const result = await reader.refresh(actor);

    expect(result.headlines.map((item) => item.title)).toEqual(["Good story"]);
    expect(persisted[0]?.map((item) => item.healthState).sort()).toEqual(["failing", "healthy"]);
  });

  it("caps converging and opposite redirect-host work at two without deadlock", async () => {
    const recipes = Array.from({ length: 6 }, (_, index) => {
      const initial = index < 3 ? `a${index}.publisher.example` : `b${index}.publisher.example`;
      const other = index % 2 === 0 ? "a.publisher.example" : "b.publisher.example";
      return {
        version: 1,
        kind: "json",
        fetchHosts: [
          initial,
          "shared.publisher.example",
          "a.publisher.example",
          "b.publisher.example"
        ],
        request: {
          urlTemplate: `https://${initial}/news?target=${index}`,
          slots: [],
          headers: { accept: "application/json" }
        },
        scopes: ["competition"],
        itemLimit: 10,
        extraction: {
          itemsPath: ["news"],
          headlinePath: ["title"],
          normalize: ["trim"]
        },
        other
      } as const;
    });
    const sources = recipes.map(({ other: _other, ...recipe }, index) =>
      runtimeSource({ id: `concurrent-${index}`, recipe, parameters: {} })
    );
    let active = 0;
    let maximum = 0;
    const fetch: SportsSafeFetchPort = async (url, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        const index = Number(new URL(url).searchParams.get("target"));
        await options?.beforeRequest?.({ url: new URL(url), redirectCount: 0 });
        await options?.beforeRequest?.({
          url: new URL(`https://shared.publisher.example/hop/${index}`),
          redirectCount: 1
        });
        await options?.beforeRequest?.({
          url: new URL(`https://${recipes[index]?.other}/final/${index}`),
          redirectCount: 2
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return success(url, `{"news":[]}`);
      } finally {
        active -= 1;
      }
    };
    const { reader } = makeReader(sources, fetch);

    await expect(reader.refresh(actor)).resolves.toMatchObject({ persistedResults: 6 });
    expect(maximum).toBeLessThanOrEqual(2);
  });
});

describe("SportsPublicSourceReader subreddit sources (#2211)", () => {
  const listingUrl = "https://www.reddit.com/r/nfl/hot.rss";
  const subreddit: SportsRuntimeSource = {
    ...runtimeSource({ id: "nfl", recipe: null, feedUrl: listingUrl, hosts: ["www.reddit.com"] }),
    label: "r/nfl",
    canonicalDomain: "reddit.com",
    retrievalMethod: "reddit",
    assignments: [
      {
        id: "assignment-nfl",
        scope: { kind: "sport", sportKey: "football" },
        targetUrl: listingUrl,
        targetParameters: {},
        previewStatus: "verified"
      }
    ]
  };
  const escape = (html: string) =>
    html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const redditEntry = (id: string, title: string, link: string | null) =>
    `<entry><category term="nfl" label="r/nfl"/><content type="html">${escape(
      `submitted by <a href="https://www.reddit.com/user/fan">/u/fan</a>` +
        (link ? ` <a href="${link}">[link]</a>` : "") +
        ` <a href="https://www.reddit.com/r/nfl/comments/${id}/">[comments]</a>`
    )}</content><id>t3_${id}</id><link href="https://www.reddit.com/r/nfl/comments/${id}/" />` +
    `<updated>2025-09-04T14:13:20+00:00</updated><published>2025-09-04T14:13:20+00:00</published>` +
    `<title>${title}</title></entry>`;
  const listing =
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    `<category term="nfl" label="r/nfl"/><title>NFL</title>` +
    redditEntry("a", "Chiefs sign a new kicker", "https://www.espn.com/nfl/story/1") +
    redditEntry("b", "Game thread", null) +
    `</feed>`;

  it("reads the feed as Reddit Atom and credits each headline to the linked publisher", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      expect(url).toBe(listingUrl);
      expect(options?.allowedHosts).toEqual(["www.reddit.com"]);
      expect(options?.allowedContentTypes).toContain("application/atom+xml");
      expect(options?.allowedContentTypes).not.toContain("application/json");
      expect(options?.userAgent).toMatch(/^Moss\//);
      expect(await permitInitialRequest(url, options)).toBe(true);
      expect(
        await options?.beforeRequest?.({
          url: new URL("https://www.reddit.com/search"),
          redirectCount: 1
        })
      ).toBe(false);
      return success(url, listing, "application/atom+xml; charset=UTF-8");
    });
    const { reader, persisted } = makeReader([subreddit], fetch);
    const result = await reader.refresh(actor);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]).toMatchObject({
      origin: "custom",
      sourceId: "nfl",
      title: "Chiefs sign a new kicker",
      url: "https://www.espn.com/nfl/story/1",
      publisherLabel: "espn.com",
      publisherDomain: "espn.com",
      sportKey: "football",
      publishedAt: "2025-09-04T14:13:20.000Z"
    });
    expect(persisted[0]?.[0]).toMatchObject({
      healthState: "healthy",
      assignmentId: "assignment-nfl"
    });
  });

  it("marks a Reddit rate limit as failing with the Reddit message, and a private subreddit as auth required", async () => {
    let status = 429;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return { ok: false, reason: "http_error", status };
    });
    const { reader, persisted } = makeReader([subreddit], fetch, { sleep: async () => {} });
    await reader.refresh(actor);
    expect(persisted[0]?.[0]).toMatchObject({
      healthState: "failing",
      healthReasonCode: "rate_limited",
      healthMessage: "Reddit is rate limiting Moss. Headlines resume automatically."
    });

    status = 403;
    await reader.refresh(actor, { bypassCache: true });
    expect(persisted.at(-1)?.[0]).toMatchObject({
      healthState: "auth_required",
      healthReasonCode: "auth_required"
    });
  });

  it("treats a non-feed body as an unsupported response", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      await permitInitialRequest(url, options);
      return success(url, "<html><body>blocked by network security</body></html>");
    });
    const { reader, persisted } = makeReader([subreddit], fetch);
    await reader.refresh(actor);
    expect(persisted[0]?.[0]).toMatchObject({
      healthState: "unsupported",
      healthReasonCode: "unsupported_response"
    });
  });
});

describe("public feed structure validation", () => {
  it("accepts legal empty RSS and Atom documents independent of item count", () => {
    expect(
      isPublicFeedDocument(
        `\uFEFF<?xml version="1.0"?><!-- publisher feed --><rss version="2.0"><channel></channel></rss>`
      )
    ).toBe(true);
    expect(isPublicFeedDocument(`<?xml version="1.0"?><!-- publisher feed --><feed></feed>`)).toBe(
      true
    );
  });

  it("rejects arbitrary and malformed XML even when it contains a feed-like root", () => {
    expect(isPublicFeedDocument(`<rss><evil /></rss>`)).toBe(false);
    expect(isPublicFeedDocument(`<document><channel /></document>`)).toBe(false);
    expect(isPublicFeedDocument(`<rss><channel></rss>`)).toBe(false);
  });
});

describe("the photo pass (#2237)", () => {
  const feedSource = () =>
    runtimeSource({
      id: "feed",
      recipe: null,
      feedUrl: "https://feeds.publisher.example/sports.xml",
      hosts: ["feeds.publisher.example"]
    });

  function feedBody(items: string): string {
    return `<rss><channel>${items}</channel></rss>`;
  }

  it("uses the feed's own media tag and serves the photo from our own address", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image" width="1200"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/story.jpg"]);
    expect(result.headlines[0]?.imageUrl).toBe(
      `/api/sports/headlines/${encodeURIComponent(result.headlines[0]!.id)}/photo`
    );
    expect(result.headlines[0]?.imageWidth).toBe(1280);
    // Only the feed itself was fetched: a usable feed photo makes the article page unnecessary.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the article page's share image when the feed has no photo", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/share.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/share.jpg"]);
    expect(result.headlines[0]?.imageUrl).not.toBeNull();
  });

  it("ignores a photo hosted somewhere unrelated to the publisher", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
              `<media:content url="https://tracker.elsewhere.test/pixel.jpg" medium="image"/></item>`
          ),
          "text/plain"
        );
      }
      return success(url, `<html><head></head></html>`, "text/html");
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual([]);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("opens no article page when under three seconds of the refresh budget remain", async () => {
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    let pageFetches = 0;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        // The feed itself was slow: 9.5 seconds of the twelve-second budget are already gone.
        clock += 9_500;
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      pageFetches += 1;
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/s.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });

    const result = await reader.refresh(actor);

    expect(pageFetches).toBe(0);
    expect(photos.stored).toEqual([]);
    // The story is still returned; only its photo is missing.
    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("never gives a download more time than the refresh has left, and skips it once time is up", async () => {
    const item =
      `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
      `<media:content url="https://publisher.example/story.jpg" medium="image" width="1200"/></item>`;

    async function budgetAfterFeedDelay(delayMs: number): Promise<(number | undefined)[]> {
      let clock = Date.parse("2026-09-04T10:00:00.000Z");
      const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
        if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
        clock += delayMs;
        return success(url, feedBody(item), "text/plain");
      });
      const photos = new PhotoStoreDouble();
      const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });
      await reader.refresh(actor);
      return photos.budgets;
    }

    // Plenty of time left: the download is capped at the store's own five-second limit.
    expect(await budgetAfterFeedDelay(500)).toEqual([5_000]);
    // Four seconds left, one above the safety margin: the download gets exactly that.
    expect(await budgetAfterFeedDelay(8_000)).toEqual([4_000]);
    // Inside the safety margin: no download is started at all.
    expect(await budgetAfterFeedDelay(11_600)).toEqual([]);
    // Past the deadline: still nothing.
    expect(await budgetAfterFeedDelay(12_500)).toEqual([]);
  });

  it("finishes the refresh inside its deadline even when a photo download hangs", async () => {
    const items = Array.from(
      { length: 4 },
      (_unused, index) =>
        `<item><guid>feed-${index}</guid><title>Story ${index}</title>` +
        `<link>https://publisher.example/story-${index}</link>` +
        `<media:content url="https://publisher.example/${index}.jpg" medium="image" width="1200"/></item>`
    ).join("");
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const started = clock;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(url, feedBody(items), "text/plain");
    });
    const photos = new PhotoStoreDouble();
    // Every download uses every millisecond it was given and then gives up, as a hung host would.
    photos.onDownload = async (allowedMs) => {
      clock += allowedMs;
      photos.alwaysFails = true;
    };
    const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });

    const result = await reader.refresh(actor);

    expect(clock - started).toBeLessThanOrEqual(REFRESH_DEADLINE_MS);
    expect(photos.stored.length).toBeLessThan(4);
    expect(result.headlines).toHaveLength(4);
  });

  it("does not download the same broken photo again on the next refresh", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/broken.jpg" medium="image" width="1200"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    photos.alwaysFails = true;
    const { reader } = makeReader([feedSource()], fetch, { photos });

    await reader.refresh(actor);
    const second = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/broken.jpg"]);
    expect(second.headlines[0]?.imageUrl).toBeNull();
  });

  it("fetches at most six article pages for one source in a refresh", async () => {
    const items = Array.from(
      { length: 9 },
      (_unused, index) =>
        `<item><guid>feed-${index}</guid><title>Story ${index}</title>` +
        `<link>https://publisher.example/story-${index}</link></item>`
    ).join("");
    let pageFetches = 0;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) return success(url, feedBody(items), "text/plain");
      pageFetches += 1;
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/s.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(pageFetches).toBe(6);
    expect(result.headlines).toHaveLength(9);
  });

  it("still returns headlines when every photo attempt fails", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      throw new Error("the publisher hung up");
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("tells the store which copies this refresh still uses", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const { headlines } = await reader.refresh(actor);

    expect(photos.swept).not.toBeNull();
    expect([...(photos.swept ?? [])]).toEqual(["key-1"]);
    expect([...photos.links.keys()]).toEqual([`user-a ${headlines[0]!.id}`]);
  });

  it("leaves every story without a photo when no store is wired in", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const { reader } = makeReader([feedSource()], fetch);

    const result = await reader.refresh(actor);

    expect(result.headlines[0]?.imageUrl).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
