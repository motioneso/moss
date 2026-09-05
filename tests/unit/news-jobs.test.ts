import { describe, expect, it } from "vitest";
import type { Job, PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner } from "@moss/db";

import {
  NEWS_REFRESH_QUEUE,
  registerNewsJobWorkers,
  type NewsRefreshPayload
} from "../../packages/news/src/jobs.js";

describe("registerNewsJobWorkers", () => {
  it("keeps recompiling in the same job until the current generation publishes", async () => {
    let run: ((jobs: Job<NewsRefreshPayload>[]) => Promise<{ outcome: string }>) | undefined;
    let sendCalls = 0;
    const boss = {
      // Two workers register now (refresh + revalidate) — capture only the refresh handler.
      work: async (queue: string, _options: unknown, handler: typeof run) => {
        if (queue === NEWS_REFRESH_QUEUE) run = handler;
        return "work-id";
      },
      send: async () => {
        sendCalls += 1;
        return "unused";
      }
    } as unknown as PgBoss;
    const dataContext = {
      withDataContext: async <T>(_access: unknown, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as DataContextRunner;

    let requestedGeneration = 1;
    let prefKey = "nytimes";
    let firstFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let releaseFirstFetch!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCount = 0;
    const publishedDomains: string[] = [];
    const repository = {
      listCustomSources: async () => [],
      listCustomTopics: async () => [],
      listExclusions: async () => [],
      readPolicyVerdict: async () => null,
      upsertPolicyVerdict: async () => undefined,
      updateSourceHealth: async () => undefined,
      recordWorkaroundRefreshOutcome: async () => undefined,
      listSourceValidationStates: async () => [],
      listTopicValidationStates: async () => [],
      updateSourceValidation: async () => undefined,
      updateTopicValidation: async () => undefined,
      beginRefreshRun: async () => requestedGeneration,
      failRefreshRunIfCurrent: async () => true,
      publishSnapshotIfCurrent: async (
        _db: DataContextDb,
        generation: number,
        input: { payload: unknown }
      ) => {
        if (generation !== requestedGeneration) return false;
        const payload = input.payload as { articles: { canonicalDomain: string }[] };
        publishedDomains.push(...payload.articles.map((article) => article.canonicalDomain));
        return true;
      }
    };

    await registerNewsJobWorkers(boss, dataContext, {
      repository,
      prefsRepository: {
        list: async () => [
          {
            id: "pref",
            kind: "source" as const,
            key: prefKey,
            createdAt: new Date().toISOString()
          }
        ]
      },
      fetch: async (url) => {
        fetchCount += 1;
        if (fetchCount === 1) {
          firstFetchStarted();
          await release;
        }
        const domain = url.includes("nytimes") ? "www.nytimes.com" : "www.theguardian.com";
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<?xml version="1.0"?><rss><channel><item><title>Current ${domain} story</title><link>https://${domain}/story</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
          truncated: false
        };
      },
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "fp",
        generateJson: async (_db, input) => ({
          ok: true,
          object: {
            rankings: [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match) => ({
              id: match[1],
              relevance: 100,
              eligible: true
            }))
          }
        })
      },
      logger: { info: () => undefined }
    });

    const jobPromise = run!([
      {
        id: "job-id",
        name: NEWS_REFRESH_QUEUE,
        data: {
          actorUserId: "00000000-0000-0000-0000-00000000000a",
          kind: "user_refresh",
          idempotencyKey: "news-refresh:user"
        }
      } as Job<NewsRefreshPayload>
    ]);
    await started;
    requestedGeneration = 2;
    prefKey = "guardian";
    releaseFirstFetch();

    await expect(jobPromise).resolves.toEqual({ outcome: "replaced" });
    expect(fetchCount).toBe(2);
    expect(publishedDomains).toEqual(["www.theguardian.com"]);
    expect(sendCalls).toBe(0);
  });

  it("never resurrects a domain excluded while an older compilation is in flight", async () => {
    let run: ((jobs: Job<NewsRefreshPayload>[]) => Promise<{ outcome: string }>) | undefined;
    const boss = {
      // Two workers register now (refresh + revalidate) — capture only the refresh handler.
      work: async (queue: string, _options: unknown, handler: typeof run) => {
        if (queue === NEWS_REFRESH_QUEUE) run = handler;
        return "work-id";
      }
    } as unknown as PgBoss;
    const dataContext = {
      withDataContext: async <T>(_access: unknown, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as DataContextRunner;
    let requestedGeneration = 1;
    let exclusions: string[] = [];
    let visibleDomains = ["www.nytimes.com"];
    const attempts: Array<{ generation: number; domains: string[] }> = [];
    let started!: () => void;
    const rankingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const rankingRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    let rankings = 0;
    const repository = {
      listCustomSources: async () => [],
      listCustomTopics: async () => [],
      listExclusions: async () =>
        exclusions.map((canonicalDomain, index) => ({
          id: `exclusion-${index}`,
          canonicalDomain,
          createdAt: new Date().toISOString()
        })),
      readPolicyVerdict: async () => null,
      upsertPolicyVerdict: async () => undefined,
      updateSourceHealth: async () => undefined,
      recordWorkaroundRefreshOutcome: async () => undefined,
      listSourceValidationStates: async () => [],
      listTopicValidationStates: async () => [],
      updateSourceValidation: async () => undefined,
      updateTopicValidation: async () => undefined,
      beginRefreshRun: async () => requestedGeneration,
      failRefreshRunIfCurrent: async () => true,
      publishSnapshotIfCurrent: async (
        _db: DataContextDb,
        generation: number,
        input: { payload: unknown }
      ) => {
        const payload = input.payload as { articles: { canonicalDomain: string }[] };
        const domains = payload.articles.map((article) => article.canonicalDomain);
        attempts.push({ generation, domains });
        if (generation !== requestedGeneration) return false;
        visibleDomains = domains;
        return true;
      }
    };
    await registerNewsJobWorkers(boss, dataContext, {
      repository,
      prefsRepository: {
        list: async () => [
          {
            id: "pref",
            kind: "source" as const,
            key: "nytimes",
            createdAt: new Date().toISOString()
          }
        ]
      },
      fetch: async (url) => {
        fetches += 1;
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<?xml version="1.0"?><rss><channel><item><title>Old publisher story</title><link>https://www.nytimes.com/story</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
          truncated: false
        };
      },
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "fp",
        generateJson: async (_db, input) => {
          rankings += 1;
          if (rankings === 1) {
            started();
            await rankingRelease;
          }
          return {
            ok: true,
            object: {
              rankings: [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match) => ({
                id: match[1],
                relevance: 100,
                eligible: true
              }))
            }
          };
        }
      },
      logger: { info: () => undefined }
    });
    const jobPromise = run!([
      {
        id: "job-id",
        name: NEWS_REFRESH_QUEUE,
        data: {
          actorUserId: "00000000-0000-0000-0000-00000000000a",
          kind: "user_refresh",
          idempotencyKey: "news-refresh:user"
        }
      } as Job<NewsRefreshPayload>
    ]);
    await rankingStarted;
    expect(visibleDomains).toEqual(["www.nytimes.com"]);
    requestedGeneration = 2;
    exclusions = ["www.nytimes.com"];
    visibleDomains = [];
    expect(visibleDomains).toEqual([]);
    release();

    await expect(jobPromise).resolves.toEqual({ outcome: "replaced" });
    expect(fetches).toBe(1);
    expect(attempts).toEqual([
      { generation: 1, domains: ["www.nytimes.com"] },
      { generation: 2, domains: [] }
    ]);
    expect(visibleDomains).toEqual([]);
  });
});
