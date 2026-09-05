import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { DatasetClient, DatasetEnvelope } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type {
  CreateNewsPrefRequest,
  NewsCustomSourceDto,
  NewsCustomTopicDto,
  NewsPrefDto,
  NewsRefreshStateDto,
  NewsSourceExclusionDto
} from "@moss/shared";

import { NewsPersonalizationLimitError } from "../../packages/news/src/personalization-repository.js";
import type { NewsPersonalizationStore } from "../../packages/news/src/personalization-routes.js";
import { registerNewsRoutes, type NewsRoutesDependencies } from "../../packages/news/src/routes.js";
import type { RssFeedItem } from "../../packages/news/src/source/rss-source.js";

/**
 * Fake `DatasetClient` for the "feed" dataset, mirroring sports-routes.test.ts. Handler errors
 * are caught and reported degraded with the fallback (as the real `createDatasetClient` does).
 */
type FeedHandler = (sourceKey: string, topicKey: string | null) => Promise<RssFeedItem[]>;

function makeDatasetClient(getFeed: FeedHandler): DatasetClient {
  return {
    async getDataset<T>(
      datasetKey: string,
      params: Record<string, unknown>,
      options: { fallback: T }
    ): Promise<DatasetEnvelope<T>> {
      try {
        if (datasetKey !== "feed") throw new Error(`unknown dataset "${datasetKey}"`);
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

const SEEDED_TOPIC_PREF: NewsPrefDto = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "topic",
  key: "technology",
  createdAt: "2026-07-01T00:00:00.000Z"
};

function feedItem(overrides: Partial<RssFeedItem> = {}): RssFeedItem {
  return {
    id: "i-1",
    title: "Chips get smaller again",
    url: "https://example.com/chips",
    publishedAt: "2026-07-08T12:00:00.000Z",
    imageUrl: null,
    summary: "A dek about chips.",
    ...overrides
  };
}

interface FakeRepo {
  list(scopedDb: DataContextDb): Promise<NewsPrefDto[]>;
  create(scopedDb: DataContextDb, input: CreateNewsPrefRequest): Promise<NewsPrefDto>;
  remove(scopedDb: DataContextDb, id: string): Promise<boolean>;
  created: CreateNewsPrefRequest[];
  removed: string[];
}

function makeRepo(initial: NewsPrefDto[]): FakeRepo {
  const created: CreateNewsPrefRequest[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    list: async () => initial,
    create: async (_db, input) => {
      created.push(input);
      return {
        id: "22222222-2222-2222-2222-222222222222",
        kind: input.kind,
        key: input.key,
        createdAt: "2026-07-08T00:00:00.000Z"
      };
    },
    remove: async (_db, id) => {
      removed.push(id);
      return true;
    }
  };
}

/**
 * Fake personalization store. `listCustomSources`/`listCustomTopics` deliberately return rows
 * carrying EXTRA module-private fields (fingerprint, provider identity) beyond the DTO so the
 * serialization tests can prove the response schemas strip them on the wire.
 */
interface FakePersonalization extends NewsPersonalizationStore {
  createdDomains: string[];
  removedIds: string[];
  refreshBumps: number[];
  prunedDomains: string[];
}

const LEAKED_SOURCE_ROW = {
  id: "33333333-3333-3333-3333-333333333333",
  label: "Custom Wire",
  canonicalDomain: "custom-wire.example",
  homepageUrl: "https://custom-wire.example",
  feedUrl: null,
  retrievalMethod: "scrape",
  validationStatus: "approved",
  healthStatus: "healthy",
  createdAt: "2026-07-10T00:00:00.000Z",
  // Module-private fields that must NEVER survive serialization:
  validationFingerprint: "vfp-SECRET-MARKER",
  provider: "provider-SECRET-MARKER"
} as unknown as NewsCustomSourceDto;

const LEAKED_TOPIC_ROW = {
  id: "44444444-4444-4444-4444-444444444444",
  label: "Fusion policy",
  guidance: "prefer primary sources",
  validationStatus: "approved",
  createdAt: "2026-07-10T00:00:00.000Z",
  validationFingerprint: "vfp-TOPIC-SECRET",
  model: "model-SECRET-MARKER"
} as unknown as NewsCustomTopicDto;

const SEEDED_EXCLUSION: NewsSourceExclusionDto = {
  id: "55555555-5555-5555-5555-555555555555",
  canonicalDomain: "tabloid.example",
  createdAt: "2026-07-09T00:00:00.000Z"
};

function makePersonalization(overrides: Partial<FakePersonalization> = {}): FakePersonalization {
  const createdDomains: string[] = [];
  const removedIds: string[] = [];
  const refreshBumps: number[] = [];
  const prunedDomains: string[] = [];
  const NO_REFRESH_HISTORY = {
    lastRequestedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureKind: null
  } as const;
  let refreshState: NewsRefreshStateDto = {
    state: "idle",
    updatedAt: null,
    ...NO_REFRESH_HISTORY
  };
  return {
    createdDomains,
    removedIds,
    refreshBumps,
    prunedDomains,
    listCustomSources: async () => [LEAKED_SOURCE_ROW],
    listCustomTopics: async () => [LEAKED_TOPIC_ROW],
    listExclusions: async () => [SEEDED_EXCLUSION],
    createExclusion: async (_db, canonicalDomain) => {
      createdDomains.push(canonicalDomain);
      return {
        id: "66666666-6666-6666-6666-666666666666",
        canonicalDomain,
        createdAt: "2026-07-11T00:00:00.000Z"
      };
    },
    removeExclusion: async (_db, id) => {
      removedIds.push(id);
      return true;
    },
    createCustomSource: async (_db, input) => ({
      id: "77777777-7777-7777-7777-777777777777",
      ...input,
      workaround: false,
      validationStatus: "approved",
      healthStatus: "healthy",
      createdAt: "2026-07-11T00:00:00.000Z"
    }),
    replaceCustomSource: async (_db, id, input) => ({
      id,
      ...input,
      workaround: false,
      validationStatus: "approved",
      healthStatus: "healthy",
      createdAt: "2026-07-11T00:00:00.000Z"
    }),
    deleteCustomSource: async () => true,
    // Interface members only — unit apps run with boss: null, so schedule reconcile never fires.
    countCustomSources: async () => 1,
    countCustomTopics: async () => 0,
    createCustomTopic: async (_db, input) => ({
      id: "88888888-8888-8888-8888-888888888888",
      label: input.label,
      guidance: input.guidance,
      validationStatus: "approved",
      createdAt: "2026-07-11T00:00:00.000Z"
    }),
    updateCustomTopic: async (_db, id, input) => ({
      id,
      label: input.label,
      guidance: input.guidance,
      validationStatus: "approved",
      createdAt: "2026-07-11T00:00:00.000Z"
    }),
    deleteCustomTopic: async () => true,
    readRefreshState: async () => refreshState,
    bumpRefreshRequest: async () => {
      refreshBumps.push(refreshBumps.length + 1);
      refreshState = {
        state: "queued",
        updatedAt: "2026-07-11T00:00:00.000Z",
        ...NO_REFRESH_HISTORY,
        lastRequestedAt: "2026-07-11T00:00:00.000Z"
      };
      return refreshBumps.length;
    },
    pruneSnapshotDomain: async (_db, domain) => {
      prunedDomains.push(domain);
    },
    updateSourceHealth: async () => undefined,
    readPolicyVerdict: async () => null,
    upsertPolicyVerdict: async () => undefined,
    readLatestSnapshot: async () => ({
      compiledAt: new Date("2026-07-11T06:00:00.000Z"),
      expiresAt: new Date("2026-07-11T07:00:00.000Z"),
      payload: {
        articles: [{ title: "PAYLOAD-ARTICLE-SECRET" }],
        compilerNote: "PAYLOAD-SECRET-MARKER"
      }
    }),
    ...overrides
  };
}

function buildApp(
  overrides: Partial<NewsRoutesDependencies> & {
    repo?: FakeRepo;
    getFeed?: FeedHandler;
    personalization?: FakePersonalization;
    hasJsonModel?: boolean;
    hasWebSearch?: boolean;
  } = {}
) {
  const repo = overrides.repo ?? makeRepo([SEEDED_TOPIC_PREF]);
  const personalization = overrides.personalization ?? makePersonalization();
  const app = Fastify();
  const deps: NewsRoutesDependencies = {
    datasetClient:
      overrides.datasetClient ?? makeDatasetClient(overrides.getFeed ?? (async () => [feedItem()])),
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: overrides.resolveAccessContext ?? (async () => userA),
    // #2005: these tests do not exercise the credential routes; the cipher is required
    // only because the route guard forbids a declared-but-unregistered route.
    credentialCipher: {
      encrypt: () => ({ version: 1, algorithm: "aes-256-gcm", iv: "", tag: "", ciphertext: "" }),
      decrypt: () => ({ apiKey: "unused" })
    },
    repository: repo,
    personalizationRepository: personalization,
    availability: {
      hasJsonModel: async () => overrides.hasJsonModel ?? true,
      hasWebSearch: async () => overrides.hasWebSearch ?? true
    },
    discovery: overrides.discovery ?? {
      fetch: async () => ({ ok: false, reason: "network" }),
      image: async () => ({ ok: false, reason: "network" }),
      search: { search: async () => ({ results: [] }) },
      ai: {
        generateJson: async () => ({
          ok: true,
          object: { allowed: true, category: "news_topic" }
        }),
        fingerprint: async () => "test-fingerprint"
      }
    },
    boss: overrides.boss ?? null
  };
  registerNewsRoutes(app, deps);
  return { app, repo, personalization };
}

describe("news routes (#897)", () => {
  it("GET /api/news/overview returns a composed 200 body with enrichment intact on the wire", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/overview" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // fast-json-stringify guard (recurring trap — #859/#885): a response schema with
    // additionalProperties:false silently DROPS any emitted field not declared in
    // packages/shared/src/news-api.ts. The seeded technology pref makes topicKey/topicLabel
    // non-null; assert they and enabledSources actually survive serialization via app.inject.
    expect(body.topStories[0]).toMatchObject({
      topicKey: "technology",
      topicLabel: "Technology",
      sourceKey: "bbc",
      sourceLabel: "BBC News"
    });
    expect(body.enabledSources).toEqual([
      { sourceKey: "bbc", label: "BBC News" },
      { sourceKey: "guardian", label: "The Guardian" },
      { sourceKey: "ap", label: "AP News" },
      { sourceKey: "npr", label: "NPR" }
    ]);
    expect(body.activeTopics).toEqual(["technology"]);
    expect(body.degraded).toBe(false);
    expect(body.sourceGroups[0].homepageUrl).toBeDefined();
    await app.close();
  });

  it("carries degraded: true to the wire when a publisher fails", async () => {
    const { app } = buildApp({
      getFeed: async (sourceKey) => {
        if (sourceKey === "guardian") throw new Error("origin down");
        return [feedItem()];
      }
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/overview" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).degraded).toBe(true);
    await app.close();
  });

  it("GET /api/news/catalog returns all 8 sources with topic coverage", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/catalog" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toHaveLength(9);
    expect(body.topics).toHaveLength(8);
    const bbc = body.sources.find((s: { sourceKey: string }) => s.sourceKey === "bbc");
    // Serialization guard: the settings pane disables topic chips per source off this array.
    expect(bbc.topics).toContain("technology");
    expect(bbc.defaultEnabled).toBe(true);
    await app.close();
  });

  it("GET /api/news/prefs returns the actor's rows", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/prefs" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).prefs).toEqual([SEEDED_TOPIC_PREF]);
    await app.close();
  });

  it("POST /api/news/prefs persists a valid source pref via the repository", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "source", key: "nytimes" }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).pref).toMatchObject({ kind: "source", key: "nytimes" });
    expect(repo.created).toEqual([{ kind: "source", key: "nytimes" }]);
    await app.close();
  });

  it("POST /api/news/prefs persists a valid topic pref", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "topic", key: "world" }
    });
    expect(res.statusCode).toBe(200);
    expect(repo.created).toEqual([{ kind: "topic", key: "world" }]);
    await app.close();
  });

  it("POST /api/news/prefs rejects an unknown source key with 400", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "source", key: "made-up-outlet" }
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toEqual([]);
    await app.close();
  });

  it("POST /api/news/prefs rejects an unknown topic key with 400", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "topic", key: "astrology" }
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toEqual([]);
    await app.close();
  });

  it("POST /api/news/prefs rejects an invalid kind at the schema layer", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "banana", key: "bbc" }
    });
    expect(res.statusCode).toBe(400);
    expect(repo.created).toEqual([]);
    await app.close();
  });

  it("DELETE /api/news/prefs/:id removes and returns ok", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/news/prefs/11111111-1111-1111-1111-111111111111"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(repo.removed).toEqual(["11111111-1111-1111-1111-111111111111"]);
    await app.close();
  });

  it("DELETE /api/news/prefs/:id rejects a non-uuid id with 400", async () => {
    const { app, repo } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "DELETE", url: "/api/news/prefs/not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(repo.removed).toEqual([]);
    await app.close();
  });

  it("maps an auth failure to 401", async () => {
    const { app } = buildApp({
      resolveAccessContext: async () => {
        throw new HttpError(401, "Session is missing or expired");
      }
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/overview" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("news personalization routes (#953 Slice 1)", () => {
  it("GET /api/news/personalization returns availability, lists, and snapshot metadata", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.availability).toEqual({
      aiConfigured: true,
      webSearchConfigured: true,
      customSourceByUrlEnabled: true,
      customSourceByNameEnabled: true,
      freeformTopicsEnabled: true
    });
    // fast-json-stringify guard (#859/#885 trap): declared DTO fields must survive the wire.
    expect(body.customSources).toEqual([
      {
        id: "33333333-3333-3333-3333-333333333333",
        label: "Custom Wire",
        canonicalDomain: "custom-wire.example",
        homepageUrl: "https://custom-wire.example",
        feedUrl: null,
        retrievalMethod: "scrape",
        validationStatus: "approved",
        healthStatus: "healthy",
        createdAt: "2026-07-10T00:00:00.000Z"
      }
    ]);
    expect(body.customTopics).toEqual([
      {
        id: "44444444-4444-4444-4444-444444444444",
        label: "Fusion policy",
        guidance: "prefer primary sources",
        validationStatus: "approved",
        createdAt: "2026-07-10T00:00:00.000Z"
      }
    ]);
    expect(body.sourceExclusions).toEqual([SEEDED_EXCLUSION]);
    // Snapshot is METADATA ONLY: compiled/expires timestamps + article count, never the payload.
    expect(body.snapshot).toEqual({
      compiledAt: "2026-07-11T06:00:00.000Z",
      expiresAt: "2026-07-11T07:00:00.000Z",
      articleCount: 1
    });
    await app.close();
  });

  it("never serializes fingerprints, provider identity, or snapshot payload content", async () => {
    const { app } = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(res.statusCode).toBe(200);
    // The fake store returns rows carrying module-private markers; none may reach the wire.
    expect(res.body).not.toContain("SECRET-MARKER");
    expect(res.body).not.toContain("vfp-");
    expect(res.body).not.toContain("PAYLOAD-ARTICLE-SECRET");
    expect(res.body).not.toContain("validationFingerprint");
    expect(res.body).not.toContain("payload");
    await app.close();
  });

  it("GET /api/news/personalization returns a null snapshot when none is stored", async () => {
    const { app } = buildApp({
      personalization: makePersonalization({ readLatestSnapshot: async () => null })
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).snapshot).toBeNull();
    await app.close();
  });

  it("derives feature enables from the availability port (JSON AI gates URL; +web search gates name/topics)", async () => {
    const { app } = buildApp({ hasJsonModel: true, hasWebSearch: false });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/news/personalization" });
    expect(JSON.parse(res.body).availability).toEqual({
      aiConfigured: true,
      webSearchConfigured: false,
      customSourceByUrlEnabled: true,
      customSourceByNameEnabled: false,
      freeformTopicsEnabled: false
    });
    await app.close();

    const { app: appNoAi } = buildApp({ hasJsonModel: false, hasWebSearch: true });
    await appNoAi.ready();
    const resNoAi = await appNoAi.inject({ method: "GET", url: "/api/news/personalization" });
    expect(JSON.parse(resNoAi.body).availability).toEqual({
      aiConfigured: false,
      webSearchConfigured: true,
      customSourceByUrlEnabled: false,
      customSourceByNameEnabled: false,
      freeformTopicsEnabled: false
    });
    await appNoAi.close();
  });

  it("POST /api/news/source-exclusions canonicalizes the input before persisting", async () => {
    const { app, personalization } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/source-exclusions",
      payload: { source: "https://News.Example.COM./politics/story?id=1" }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).exclusion.canonicalDomain).toBe("news.example.com");
    expect(personalization.createdDomains).toEqual(["news.example.com"]);
    await app.close();
  });

  it("POST /api/news/source-exclusions rejects invalid domains with 400 before any write", async () => {
    const { app, personalization } = buildApp();
    await app.ready();
    for (const source of [
      "http://insecure.example.com",
      "https://192.168.0.1/feed",
      "localhost",
      "https://user:pw@example.com",
      "https://example.com:8443"
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/news/source-exclusions",
        payload: { source }
      });
      expect(res.statusCode).toBe(400);
    }
    expect(personalization.createdDomains).toEqual([]);
    await app.close();
  });

  it("POST /api/news/source-exclusions maps the per-owner cap to 400, not 500", async () => {
    const { app } = buildApp({
      personalization: makePersonalization({
        createExclusion: async () => {
          throw new NewsPersonalizationLimitError("source_exclusions", 100);
        }
      })
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/news/source-exclusions",
      payload: { source: "example.com" }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE /api/news/source-exclusions/:id removes and returns ok", async () => {
    const { app, personalization } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/news/source-exclusions/55555555-5555-5555-5555-555555555555"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(personalization.removedIds).toEqual(["55555555-5555-5555-5555-555555555555"]);
    await app.close();
  });

  it("DELETE /api/news/source-exclusions/:id rejects a non-uuid id with 400", async () => {
    const { app, personalization } = buildApp();
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/news/source-exclusions/not-a-uuid"
    });
    expect(res.statusCode).toBe(400);
    expect(personalization.removedIds).toEqual([]);
    await app.close();
  });

  it("maps an auth failure on the personalization routes to 401", async () => {
    const { app } = buildApp({
      resolveAccessContext: async () => {
        throw new HttpError(401, "Session is missing or expired");
      }
    });
    await app.ready();
    for (const request of [
      { method: "GET" as const, url: "/api/news/personalization" },
      {
        method: "POST" as const,
        url: "/api/news/source-exclusions",
        payload: { source: "example.com" }
      },
      {
        method: "DELETE" as const,
        url: "/api/news/source-exclusions/55555555-5555-5555-5555-555555555555"
      }
    ]) {
      const res = await app.inject(request);
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });
});

describe("news personalization routes (#958 Slice 2)", () => {
  const feed = `<?xml version="1.0"?><rss><channel><title>Example News</title><item><title>Verified publisher headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

  it("previews and confirms a verified source without exposing its fingerprint", async () => {
    const { app, personalization } = buildApp({
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: feed,
          truncated: false
        }),
        image: async () => ({ ok: false, reason: "network" }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          generateJson: async () => ({
            ok: true,
            object: { allowed: true, category: "news_publisher" }
          }),
          fingerprint: async () => "private-fingerprint"
        }
      }
    });
    await app.ready();
    const preview = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "https://example.com/feed.xml" }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).not.toContain("fingerprint");
    const previewBody = JSON.parse(preview.body);
    expect(previewBody).toMatchObject({
      status: "ok",
      candidates: [{ canonicalDomain: "example.com", retrievalMethod: "feed", sampleCount: 1 }]
    });

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/news/sources",
      payload: { confirmationId: previewBody.confirmationId }
    });
    expect(confirmed.statusCode).toBe(201);
    expect(JSON.parse(confirmed.body).source.canonicalDomain).toBe("example.com");
    expect(personalization.refreshBumps).toHaveLength(1);
    await app.close();
  });

  it("returns the declared prerequisite envelope when no JSON model is available", async () => {
    const { app } = buildApp({ hasJsonModel: false });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "example.com" }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "unavailable",
      error: {
        code: "news.add_source.no_json_model",
        class: "prerequisite",
        remediationRef: "news.add_source.configure_json_model"
      }
    });
    await app.close();
  });

  it("classifies provider discovery failure as transient without remediation", async () => {
    const { app } = buildApp({ hasJsonModel: true, hasWebSearch: false });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "Example News Co" }
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).error).toEqual({
      code: "news.add_source.discovery_unavailable",
      class: "transient"
    });
    await app.close();
  });

  it("rejects a topic when the provider policy does not affirm it", async () => {
    const { app, personalization } = buildApp({
      discovery: {
        fetch: async () => ({ ok: false, reason: "network" }),
        image: async () => ({ ok: false, reason: "network" }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          generateJson: async () => ({
            ok: true,
            object: { allowed: false, category: "news_topic" }
          }),
          fingerprint: async () => "policy-fingerprint"
        }
      }
    });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/topics",
      payload: { label: "Disallowed topic" }
    });
    expect(response.statusCode).toBe(422);
    expect(personalization.refreshBumps).toEqual([]);
    await app.close();
  });

  it("rejects topic creation when web search is unavailable", async () => {
    const { app, personalization } = buildApp({ hasWebSearch: false });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/topics",
      payload: { label: "Watches" }
    });
    expect(response.statusCode).toBe(503);
    expect(personalization.refreshBumps).toEqual([]);
    await app.close();
  });

  it("bumps the generation for every curated preference change", async () => {
    const { app, personalization } = buildApp();
    await app.ready();
    await app.inject({
      method: "POST",
      url: "/api/news/prefs",
      payload: { kind: "source", key: "nytimes" }
    });
    await app.inject({
      method: "DELETE",
      url: "/api/news/prefs/11111111-1111-1111-1111-111111111111"
    });
    expect(personalization.refreshBumps).toEqual([1, 2]);
    await app.close();
  });

  it("bumps before pruning a newly excluded domain", async () => {
    const events: string[] = [];
    const personalization = makePersonalization({
      bumpRefreshRequest: async () => {
        events.push("bump");
        return 1;
      },
      pruneSnapshotDomain: async (_db, domain) => {
        events.push(`prune:${domain}`);
      }
    });
    const { app } = buildApp({ personalization });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/source-exclusions",
      payload: { source: "example.com" }
    });
    expect(response.statusCode).toBe(200);
    expect(events).toEqual(["bump", "prune:example.com"]);
    await app.close();
  });

  it("refreshes a stale snapshot on open but leaves a fresh snapshot alone", async () => {
    const fresh = makePersonalization({
      readLatestSnapshot: async () => ({
        compiledAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        payload: { articles: [] }
      })
    });
    const { app: freshApp } = buildApp({ personalization: fresh });
    await freshApp.ready();
    await freshApp.inject({ method: "GET", url: "/api/news/personalization" });
    expect(fresh.refreshBumps).toEqual([]);
    await freshApp.close();

    const stale = makePersonalization({
      readLatestSnapshot: async () => ({
        compiledAt: new Date(Date.now() - 31 * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        payload: { articles: [] }
      })
    });
    const { app: staleApp } = buildApp({ personalization: stale });
    await staleApp.ready();
    await staleApp.inject({ method: "GET", url: "/api/news/personalization" });
    expect(stale.refreshBumps).toEqual([1]);
    await staleApp.close();
  });

  it("serves a stale personalized overview immediately and coalesces a replacement refresh", async () => {
    const article = {
      id: "snapshot-story",
      publisher: "Example News",
      canonicalDomain: "example.com",
      headline: "Personalized headline",
      url: "https://example.com/story",
      publishedAt: new Date(Date.now() - 60_000).toISOString(),
      excerpt: "Personalized summary",
      imageUrl: "https://images.example/story.png",
      topics: ["AI"],
      preferred: true,
      rank: 1
    };
    const stale = makePersonalization({
      readLatestSnapshot: async () => ({
        compiledAt: new Date(Date.now() - 31 * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        payload: { articles: [article] }
      })
    });
    const { app } = buildApp({ personalization: stale });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/news/overview" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.rankedStories).toHaveLength(1);
    expect(body.rankedStories[0]).toMatchObject({
      id: "snapshot-story",
      imageUrl: "/api/news/images/snapshot-story",
      topicLabels: ["AI"]
    });
    expect(response.body).not.toContain("images.example");
    expect(stale.refreshBumps).toEqual([1]);
    await app.close();
  });

  it("does not refresh a five-minute personalized overview", async () => {
    const fresh = makePersonalization({
      readLatestSnapshot: async () => ({
        compiledAt: new Date(Date.now() - 5 * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        payload: { articles: [] }
      })
    });
    const { app } = buildApp({ personalization: fresh });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/news/overview" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).rankedStories).toEqual([]);
    expect(fresh.refreshBumps).toEqual([]);
    await app.close();
  });
});
