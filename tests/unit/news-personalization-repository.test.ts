import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection
} from "kysely";

import { dataContextBrand, type DataContextDb, type MossDatabase } from "@moss/db";
import {
  NEWS_MAX_SOURCE_EXCLUSIONS,
  NewsDuplicateSourceError,
  NewsPersonalizationLimitError,
  NewsPersonalizationRepository
} from "../../packages/news/src/personalization-repository.js";
import { isWorkaroundFeed } from "../../packages/news/src/source/workaround.js";

// #953 Task 3 — the pure branches only. RLS/cap/upsert behavior needs Postgres and lives in
// tests/integration/news-personalization-repository.test.ts.

/** Branded stub whose `db` explodes on ANY access — proves a code path never reaches SQL. */
function sqlExplodingScopedDb(): DataContextDb {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("unexpected SQL access");
      }
    }
  );
  return { db, [dataContextBrand]: true } as DataContextDb;
}

describe("news personalization repository pure branches (#953 Task 3)", () => {
  const repo = new NewsPersonalizationRepository();

  it("exposes the spec's exclusion cap as a constant", () => {
    expect(NEWS_MAX_SOURCE_EXCLUSIONS).toBe(100);
  });

  it("NewsPersonalizationLimitError carries the resource and limit for typed handling", () => {
    const error = new NewsPersonalizationLimitError("source_exclusions", 100);
    expect(error).toBeInstanceOf(Error);
    expect(error.resource).toBe("source_exclusions");
    expect(error.limit).toBe(100);
    expect(error.message).toContain("100");
  });

  it("replaceLatestSnapshot runs the payload guard BEFORE touching SQL", async () => {
    await expect(
      repo.replaceLatestSnapshot(sqlExplodingScopedDb(), {
        compiledAt: new Date("2026-07-11T06:00:00Z"),
        expiresAt: new Date("2026-07-11T12:00:00Z"),
        payload: { articles: "not-an-array" }
      })
    ).rejects.toThrow(/articles/);
  });
});

// ---------------------------------------------------------------------------
// #2282 Task 1.4 — SQL shape against a recording Kysely driver (copied from
// tests/unit/news-credential-repository.test.ts). The behaviour only Postgres can prove
// (partial unique indexes, RLS, the failure-count grant) lives in the integration file.
// ---------------------------------------------------------------------------

interface Recorded {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A Kysely whose driver records every compiled query and replays queued result rows. */
function makeRecordingDb(): {
  scoped: DataContextDb;
  queries: Recorded[];
  queue: (rows: Record<string, unknown>[]) => void;
} {
  const queries: Recorded[] = [];
  const pending: Record<string, unknown>[][] = [];

  const connection = {
    executeQuery: async (compiled: CompiledQuery) => {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      return { rows: pending.shift() ?? [] };
    },
    streamQuery: () => {
      throw new Error("streaming is not used by this repository");
    }
  } as unknown as DatabaseConnection;

  class RecordingDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return connection;
    }
  }

  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });

  return {
    scoped: { db, [dataContextBrand]: true } as unknown as DataContextDb,
    queries,
    queue: (rows) => pending.push(rows)
  };
}

/** Compiled SQL, lowercased and whitespace-collapsed, so assertions ignore layout. */
function compiledSql(queries: Recorded[], index: number): string {
  const entry = queries[index];
  if (!entry) throw new Error(`no query recorded at index ${index}`);
  return entry.sql.toLowerCase().replace(/\s+/g, " ");
}

const SOURCE_ID = "44444444-4444-4444-4444-444444444444";

const publicationInput = {
  label: "The Example Times",
  canonicalDomain: "news.example.com",
  homepageUrl: "https://news.example.com",
  feedUrl: "https://news.example.com/feed",
  retrievalMethod: "feed" as const,
  confirmedFetchHosts: ["news.example.com"],
  iconUrl: null,
  validationFingerprint: "fp-1"
};

const subredditInput = {
  label: "r/nfl",
  canonicalDomain: "reddit.com",
  homepageUrl: "https://www.reddit.com/r/nfl/",
  feedUrl: "https://www.reddit.com/r/NFL/hot.rss",
  retrievalMethod: "reddit" as const,
  confirmedFetchHosts: ["www.reddit.com"],
  iconUrl: "https://styles.redditmedia.com/nfl.png",
  validationFingerprint: "fp-r"
};

const storedRow = {
  id: SOURCE_ID,
  label: "The Example Times",
  canonical_domain: "news.example.com",
  homepage_url: "https://news.example.com",
  feed_url: "https://mirror.example.net/feed.xml",
  retrieval_method: "feed",
  validation_status: "approved",
  health_status: "healthy",
  created_at: new Date("2026-09-05T06:00:00Z"),
  // Columns the DTO must never carry, even if a wider SELECT ever leaked them.
  confirmed_fetch_hosts: ["news.example.com", "mirror.example.net"],
  icon_url: "https://news.example.com/icon.png",
  consecutive_failures: 2,
  validation_fingerprint: "fp-secret-marker"
};

describe("news personalization repository source kinds (#2282 Task 1.4)", () => {
  const repo = new NewsPersonalizationRepository();

  it("createCustomSource inserts with an untargeted ON CONFLICT DO NOTHING and the new columns", async () => {
    const { scoped, queries, queue } = makeRecordingDb();
    queue([storedRow]);
    await repo.createCustomSource(scoped, publicationInput);
    const insert = compiledSql(queries, 0);
    expect(insert).toContain("on conflict do nothing");
    expect(insert).not.toMatch(/on conflict \(/);
    expect(insert).toContain("confirmed_fetch_hosts");
    expect(insert).toContain("icon_url");
    expect(queries[0]?.parameters).toEqual(
      expect.arrayContaining([["news.example.com"], "https://news.example.com/feed"])
    );
  });

  it("a Reddit duplicate is probed by the lowercased feed URL, not by canonical domain", async () => {
    const { scoped, queries, queue } = makeRecordingDb();
    queue([]); // insert: no row (conflict or cap)
    queue([{ id: SOURCE_ID }]); // duplicate probe: hit
    await expect(repo.createCustomSource(scoped, subredditInput)).rejects.toBeInstanceOf(
      NewsDuplicateSourceError
    );
    const probe = compiledSql(queries, 1);
    expect(probe).toContain("lower(feed_url)");
    expect(probe).toContain("retrieval_method");
    expect(probe).not.toContain("canonical_domain");
    expect(queries[1]?.parameters).toContain("https://www.reddit.com/r/nfl/hot.rss");
  });

  it("a publication duplicate is still probed by canonical domain", async () => {
    const { scoped, queries, queue } = makeRecordingDb();
    queue([]);
    queue([{ id: SOURCE_ID }]);
    await expect(repo.createCustomSource(scoped, publicationInput)).rejects.toBeInstanceOf(
      NewsDuplicateSourceError
    );
    const probe = compiledSql(queries, 1);
    expect(probe).toContain("canonical_domain");
    expect(probe).not.toContain("feed_url");
    expect(queries[1]?.parameters).toContain("news.example.com");
  });

  it("a miss on both the insert and the probe is the per-user cap, not a duplicate", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([]);
    queue([]);
    await expect(repo.createCustomSource(scoped, subredditInput)).rejects.toBeInstanceOf(
      NewsPersonalizationLimitError
    );
  });

  it("replaceCustomSource writes the new columns and resets the failure count", async () => {
    const { scoped, queries, queue } = makeRecordingDb();
    queue([storedRow]);
    await repo.replaceCustomSource(scoped, SOURCE_ID, subredditInput);
    const update = compiledSql(queries, 0);
    expect(update).toContain("confirmed_fetch_hosts");
    expect(update).toContain("icon_url");
    expect(update).toContain("consecutive_failures");
    expect(queries[0]?.parameters).toEqual(expect.arrayContaining([0, ["www.reddit.com"]]));
  });

  it("the DTO carries retrievalMethod and workaround but never hosts, icon, count or fingerprint", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([storedRow]);
    const [dto] = await repo.listCustomSources(scoped);
    expect(dto?.retrievalMethod).toBe("feed");
    expect(dto?.workaround).toBe(true);
    const json = JSON.stringify(dto);
    expect(json).not.toContain('mirror.example.net"]');
    expect(json).not.toContain("confirmed");
    expect(json).not.toContain("icon");
    expect(json).not.toContain("consecutive");
    expect(json).not.toContain("fingerprint");
    expect(json).not.toContain("fp-secret-marker");
  });

  it("a subreddit row is not a workaround", async () => {
    const { scoped, queue } = makeRecordingDb();
    queue([
      {
        ...storedRow,
        canonical_domain: "reddit.com",
        homepage_url: "https://www.reddit.com/r/nfl/",
        feed_url: "https://www.reddit.com/r/nfl/hot.rss",
        retrieval_method: "reddit"
      }
    ]);
    const [dto] = await repo.listCustomSources(scoped);
    expect(dto?.retrievalMethod).toBe("reddit");
    expect(dto?.workaround).toBe(false);
  });

  it("recordWorkaroundRefreshOutcome: success resets the count in one UPDATE", async () => {
    const { scoped, queries } = makeRecordingDb();
    await repo.recordWorkaroundRefreshOutcome(scoped, SOURCE_ID, "success");
    expect(queries).toHaveLength(1);
    const update = compiledSql(queries, 0);
    expect(update).toContain('update "app"."news_custom_sources"');
    expect(update).toContain("consecutive_failures");
    expect(update).not.toContain("least(");
    expect(update).toContain('where "id" = $');
    expect(queries[0]?.parameters).toEqual(expect.arrayContaining([0, SOURCE_ID]));
  });

  it("recordWorkaroundRefreshOutcome: failure bumps the bounded count and flips health at three", async () => {
    const { scoped, queries } = makeRecordingDb();
    await repo.recordWorkaroundRefreshOutcome(scoped, SOURCE_ID, "failure");
    expect(queries).toHaveLength(1);
    const update = compiledSql(queries, 0);
    expect(update).toContain("least(");
    expect(update).toContain("temporarily_unavailable");
    expect(update).toContain("health_status");
    expect(update).toContain('where "id" = $');
    expect(queries[0]?.parameters).toContain(SOURCE_ID);
  });

  it("every new path refuses an unscoped handle before touching SQL", async () => {
    const unscoped = { db: {} } as unknown as DataContextDb;
    await expect(
      repo.recordWorkaroundRefreshOutcome(unscoped, SOURCE_ID, "success")
    ).rejects.toThrow();
    await expect(repo.createCustomSource(unscoped, publicationInput)).rejects.toThrow();
  });
});

describe("isWorkaroundFeed (#2282 Task 1.4)", () => {
  it("is false when there is no feed URL", () => {
    expect(isWorkaroundFeed("news.example.com", null)).toBe(false);
  });

  it("is false when the feed host is the publisher or one of its subdomains", () => {
    expect(isWorkaroundFeed("news.example.com", "https://news.example.com/feed")).toBe(false);
    expect(isWorkaroundFeed("example.com", "https://feeds.example.com/rss")).toBe(false);
    // The canonical domain may itself be a subdomain of the feed host (www/apex).
    expect(isWorkaroundFeed("www.reddit.com", "https://reddit.com/r/nfl/hot.rss")).toBe(false);
  });

  it("is true when the feed host belongs to a different publisher", () => {
    expect(isWorkaroundFeed("news.example.com", "https://mirror.example.net/feed.xml")).toBe(true);
    // Suffix tricks never count as the same publisher.
    expect(isWorkaroundFeed("example.com", "https://notexample.com/feed")).toBe(true);
    expect(isWorkaroundFeed("example.com", "https://example.com.evil.com/feed")).toBe(true);
  });

  it("compares hosts case-insensitively and ignores paths, ports and query strings", () => {
    expect(isWorkaroundFeed("news.example.com", "https://NEWS.Example.COM:443/feed?x=1")).toBe(
      false
    );
  });

  it("treats an unparseable feed URL as not a workaround", () => {
    expect(isWorkaroundFeed("news.example.com", "not a url")).toBe(false);
  });
});
