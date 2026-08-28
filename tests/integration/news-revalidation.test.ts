import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { assertMetadataOnlyPayload, createPgBossClient } from "@moss/jobs";
import { NotificationsRepository } from "@moss/notifications";

import type { NewsCompilationLogFields } from "../../packages/news/src/compilation/compile.js";
import type { NewsAiPort, NewsSafeFetchPort } from "../../packages/news/src/discovery/ports.js";
import {
  enqueueNewsRefresh,
  enqueueNewsRevalidation,
  NEWS_REVALIDATE_QUEUE,
  registerNewsJobWorkers
} from "../../packages/news/src/jobs.js";
import {
  NewsPersonalizationRepository,
  type NewsSourceValidationState,
  type NewsTopicValidationState
} from "../../packages/news/src/personalization-repository.js";
import { registerNewsPersonalizationRoutes } from "../../packages/news/src/personalization-routes.js";
import {
  revalidateOwnerNews,
  type NewsRevalidationDeps,
  type NewsRevalidationLogFields
} from "../../packages/news/src/revalidation.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #975 Slice 4 Task 3 — provider-change revalidation core, exercised with stub ports
// (pattern: news-refresh-jobs.test.ts). The repository is an in-memory spy so we can
// assert "zero writes" for the idempotent/skip paths; RLS behavior of the real repository
// methods is covered by news-personalization-repository.test.ts.
const scopedDb = {} as unknown as DataContextDb;

type MutableSource = {
  -readonly [K in keyof NewsSourceValidationState]: NewsSourceValidationState[K];
};
type MutableTopic = {
  -readonly [K in keyof NewsTopicValidationState]: NewsTopicValidationState[K];
};

function makeSource(overrides: Partial<MutableSource> = {}): MutableSource {
  return {
    id: "src-1",
    label: "The Example Times",
    canonicalDomain: "news.example.com",
    homepageUrl: "https://news.example.com",
    feedUrl: "https://news.example.com/feed",
    retrievalMethod: "feed",
    validationStatus: "approved",
    validationFingerprint: "fp2",
    healthStatus: "healthy",
    ...overrides
  };
}

function makeTopic(overrides: Partial<MutableTopic> = {}): MutableTopic {
  return {
    id: "top-1",
    label: "AI Safety",
    guidance: "focus on policy",
    validationStatus: "approved",
    validationFingerprint: "fp2",
    ...overrides
  };
}

function makeRepository(sources: MutableSource[], topics: MutableTopic[]) {
  const writes: string[] = [];
  const repository: NewsRevalidationDeps["repository"] = {
    listSourceValidationStates: async () => sources.map((source) => ({ ...source })),
    listTopicValidationStates: async () => topics.map((topic) => ({ ...topic })),
    updateSourceValidation: async (_db, sourceId, input) => {
      writes.push(`source:${sourceId}:${input.validationStatus}`);
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      source.validationStatus = input.validationStatus;
      if (input.validationFingerprint !== null) {
        source.validationFingerprint = input.validationFingerprint;
      }
    },
    updateTopicValidation: async (_db, topicId, input) => {
      writes.push(`topic:${topicId}:${input.validationStatus}`);
      const topic = topics.find((candidate) => candidate.id === topicId);
      if (!topic) throw new Error(`unknown topic ${topicId}`);
      topic.validationStatus = input.validationStatus;
      if (input.validationFingerprint !== null) {
        topic.validationFingerprint = input.validationFingerprint;
      }
    },
    updateSourceHealth: async (_db, sourceId, health) => {
      writes.push(`health:${sourceId}:${health}`);
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      source.healthStatus = health;
    },
    readPolicyVerdict: async () => null,
    upsertPolicyVerdict: async () => {
      writes.push("verdict-upsert");
    }
  };
  return { repository, writes, sources, topics };
}

const FEED_BODY =
  `<?xml version="1.0"?><rss><channel>` +
  `<item><title>Example headline about important current events</title>` +
  `<link>https://news.example.com/story</link></item>` +
  `</channel></rss>`;

const fetchOk: NewsSafeFetchPort = async (url) => ({
  ok: true,
  status: 200,
  finalUrl: url,
  contentType: "application/rss+xml",
  body: FEED_BODY,
  truncated: false
});

const fetchFail: NewsSafeFetchPort = async () => ({ ok: false, reason: "network" });

// Req C sentinel scan (#975 council re-run): one distinctive string seeded into EVERY
// private input — fetched article body, source label, topic label, topic guidance — then
// asserted absent from every surface that leaves the process (pg-boss rows, process logs,
// notification rows). Distinctive enough that any occurrence anywhere is a real leak.
const SENTINEL = "SENTINEL-975-PRIVATE-e5b1c9";

const SENTINEL_FEED_BODY =
  `<?xml version="1.0"?><rss><channel>` +
  `<item><title>Example headline ${SENTINEL} about important current events</title>` +
  `<link>https://news.example.com/story</link></item>` +
  `</channel></rss>`;

const sentinelFetch: NewsSafeFetchPort = async (url) => ({
  ok: true,
  status: 200,
  finalUrl: url,
  contentType: "application/rss+xml",
  body: SENTINEL_FEED_BODY,
  truncated: false
});

/** Stub AI: fixed fingerprint, approves/rejects per `allowed`, category read from schema. */
function makeAi(opts: { fingerprint: string | null; allowed?: boolean }): NewsAiPort {
  return {
    fingerprint: async () => opts.fingerprint,
    generateJson: async (_db, input) => {
      const schema = input.schema as {
        properties: { category: { enum: readonly string[] } };
      };
      return {
        ok: true,
        object: { allowed: opts.allowed ?? true, category: schema.properties.category.enum[0] }
      };
    }
  };
}

function makeLogger() {
  const events: NewsRevalidationLogFields[] = [];
  return { logger: { info: (fields: NewsRevalidationLogFields) => events.push(fields) }, events };
}

describe("news revalidation core (#975 Slice 4)", () => {
  it("skips everything when all items are approved under the current fingerprint", async () => {
    const { repository, writes } = makeRepository([makeSource()], [makeTopic()]);
    const { logger } = makeLogger();
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: fetchOk,
      ai: makeAi({ fingerprint: "fp2" }),
      repository,
      logger
    });
    expect(outcome).toEqual({
      sourcesChecked: 0,
      topicsChecked: 0,
      sourcesNeedingAttention: 0,
      topicsNeedingAttention: 0,
      transitionedToAttention: false
    });
    expect(writes).toEqual([]);
  });

  it("re-approves drifted items under the new fingerprint without raising attention", async () => {
    const { repository, sources, topics } = makeRepository(
      [makeSource({ validationFingerprint: "fp1" })],
      [makeTopic({ validationFingerprint: "fp1" })]
    );
    const { logger } = makeLogger();
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: fetchOk,
      ai: makeAi({ fingerprint: "fp2" }),
      repository,
      logger
    });
    expect(outcome).toEqual({
      sourcesChecked: 1,
      topicsChecked: 1,
      sourcesNeedingAttention: 0,
      topicsNeedingAttention: 0,
      transitionedToAttention: false
    });
    expect(sources[0]).toMatchObject({
      validationStatus: "approved",
      validationFingerprint: "fp2",
      healthStatus: "healthy"
    });
    expect(topics[0]).toMatchObject({
      validationStatus: "approved",
      validationFingerprint: "fp2"
    });
  });

  it("marks unreachable sources unavailable + needs_revalidation and raises attention", async () => {
    const { repository, sources } = makeRepository(
      [makeSource({ validationFingerprint: "fp1" })],
      []
    );
    const { logger } = makeLogger();
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: fetchFail,
      ai: makeAi({ fingerprint: "fp2" }),
      repository,
      logger
    });
    expect(outcome).toMatchObject({
      sourcesChecked: 1,
      sourcesNeedingAttention: 1,
      transitionedToAttention: true
    });
    expect(sources[0]).toMatchObject({
      validationStatus: "needs_revalidation",
      healthStatus: "temporarily_unavailable"
    });
  });

  it("rejects items the new provider disallows and raises attention", async () => {
    const { repository, sources, topics } = makeRepository(
      [makeSource({ validationFingerprint: "fp1" })],
      [makeTopic({ validationFingerprint: "fp1" })]
    );
    const { logger } = makeLogger();
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: fetchOk,
      ai: makeAi({ fingerprint: "fp2", allowed: false }),
      repository,
      logger
    });
    expect(outcome).toEqual({
      sourcesChecked: 1,
      topicsChecked: 1,
      sourcesNeedingAttention: 1,
      topicsNeedingAttention: 1,
      transitionedToAttention: true
    });
    expect(sources[0]).toMatchObject({
      validationStatus: "rejected",
      validationFingerprint: "fp2"
    });
    expect(topics[0]).toMatchObject({ validationStatus: "rejected", validationFingerprint: "fp2" });
  });

  it("does not re-raise attention on a second identical run (notification dedupe)", async () => {
    const { repository } = makeRepository(
      [makeSource({ validationFingerprint: "fp1" })],
      [makeTopic({ validationFingerprint: "fp1" })]
    );
    const { logger } = makeLogger();
    const deps = {
      fetch: fetchOk,
      ai: makeAi({ fingerprint: "fp2", allowed: false }),
      repository,
      logger
    };
    const first = await revalidateOwnerNews(scopedDb, deps);
    expect(first.transitionedToAttention).toBe(true);
    const second = await revalidateOwnerNews(scopedDb, deps);
    expect(second).toMatchObject({
      sourcesNeedingAttention: 1,
      topicsNeedingAttention: 1,
      transitionedToAttention: false
    });
  });

  it("makes no writes and logs a metadata-only skip when no model is configured", async () => {
    const { repository, writes } = makeRepository(
      [makeSource({ validationFingerprint: "fp1" })],
      [makeTopic({ validationFingerprint: "fp1" })]
    );
    const { logger, events } = makeLogger();
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: fetchOk,
      ai: makeAi({ fingerprint: null }),
      repository,
      logger
    });
    expect(outcome).toEqual({
      sourcesChecked: 0,
      topicsChecked: 0,
      sourcesNeedingAttention: 0,
      topicsNeedingAttention: 0,
      transitionedToAttention: false
    });
    expect(writes).toEqual([]);
    expect(events).toEqual([{ event: "news_revalidation_skipped", reason: "no_model" }]);
  });
});

/**
 * DB-backed queue/worker coverage (#975 Slice 4 Task 4): the `news.revalidate` queue,
 * its worker (revalidation + ONE summary notification on transition-to-attention), and
 * the refresh worker's fingerprint-drift hook that enqueues revalidation.
 */
describe("news revalidation jobs (#975 Slice 4)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let bootstrap: pg.Client;
  const repository = new NewsPersonalizationRepository();
  const notifications = new NotificationsRepository();

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    appContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    appBoss = createPgBossClient(connectionStrings.app);
    workerBoss = createPgBossClient(connectionStrings.worker);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await Promise.all([appBoss.start(), workerBoss.start(), bootstrap.connect()]);
  });

  afterEach(async () => {
    await Promise.allSettled([
      appBoss.stop({ graceful: false }),
      workerBoss.stop({ graceful: false }),
      appDb.destroy(),
      workerDb.destroy(),
      bootstrap.end()
    ]);
  });

  const asActor = <T>(work: (db: DataContextDb) => Promise<T>) =>
    appContext.withDataContext({ actorUserId: ids.userA, requestId: crypto.randomUUID() }, work);

  /**
   * One approved custom source + topic for userA, validated under `fingerprint`.
   * Label/guidance are SQL params so the Req C sentinel tests (#975 council re-run) can
   * push private strings through the exact same seed path; existing callers keep the
   * original literals via the default.
   */
  async function seedValidationRows(
    fingerprint: string,
    opts: { sentinel?: string } = {}
  ): Promise<void> {
    const suffix = opts.sentinel ? ` ${opts.sentinel}` : "";
    await bootstrap.query(
      `INSERT INTO app.news_custom_sources
         (owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
          validation_status, health_status, validation_fingerprint, validated_at, updated_at)
       VALUES ($1, $3, 'news.example.com', 'https://news.example.com',
               'https://news.example.com/feed', 'feed', 'approved', 'healthy', $2,
               now() - interval '1 day', now() - interval '1 day')`,
      [ids.userA, fingerprint, `The Example Times${suffix}`]
    );
    await bootstrap.query(
      `INSERT INTO app.news_custom_topics
         (owner_user_id, label, guidance, validation_status, validation_fingerprint,
          validated_at, updated_at)
       VALUES ($1, $3, $4, 'approved', $2,
               now() - interval '1 day', now() - interval '1 day')`,
      [ids.userA, fingerprint, `AI Safety${suffix}`, `focus on policy${suffix}`]
    );
  }

  async function waitFor<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await probe();
      if (value !== null) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function countRevalidateJobs(state?: string): Promise<number> {
    const result = await bootstrap.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1` +
        (state ? ` AND state = $2` : ``),
      state ? [NEWS_REVALIDATE_QUEUE, state] : [NEWS_REVALIDATE_QUEUE]
    );
    return result.rows[0]!.n;
  }

  /**
   * Dual-mode stub: policy calls (schema carries `category`) get an allow/deny verdict;
   * compilation ranking calls get every candidate ranked eligible. One stub serves both
   * the refresh worker (compile) and the revalidation worker (policy) in the same run.
   */
  function makeWorkerAi(opts: { fingerprint: string; allowed: boolean }): NewsAiPort {
    return {
      fingerprint: async () => opts.fingerprint,
      generateJson: async (_db, input) => {
        const schema = input.schema as {
          properties?: Record<string, { enum?: readonly string[] }>;
        };
        const categoryEnum = schema.properties?.category?.enum;
        if (categoryEnum) {
          return { ok: true, object: { allowed: opts.allowed, category: categoryEnum[0] } };
        }
        return {
          ok: true,
          object: {
            rankings: [...input.prompt.matchAll(/"id":"(c\d+)"/g)].map((match, index) => ({
              id: match[1],
              relevance: 100 - index,
              eligible: true
            }))
          }
        };
      }
    };
  }

  function registerWorkers(overrides: {
    ai: NewsAiPort;
    fetch?: NewsSafeFetchPort;
    logger?: { info(fields: NewsCompilationLogFields): void };
    notificationsRepository?: { create: NotificationsRepository["create"] };
    revalidationLogger?: { info: (fields: NewsRevalidationLogFields) => void };
  }) {
    return registerNewsJobWorkers(workerBoss, workerContext, {
      fetch: overrides.fetch ?? fetchOk,
      search: { search: async () => ({ results: [] }) },
      ai: overrides.ai,
      logger: overrides.logger ?? { info: () => undefined },
      notificationsRepository: overrides.notificationsRepository ?? notifications,
      revalidationLogger: overrides.revalidationLogger ?? { info: () => undefined }
    });
  }

  /**
   * Req C leak scan (#975 council re-run): stringify every externally visible surface and
   * return the names of those containing the sentinel. `jobRows` covers BOTH the pg-boss
   * payload (`data`) and the worker result (`output` — carries transitionedToAttention in
   * the real flow, so a regression could smuggle content there too). Callers pass the
   * captured in-process log arrays and the notification rows they read back.
   */
  async function sentinelLeaks(captured: Record<string, unknown>): Promise<string[]> {
    const jobs = await bootstrap.query(`SELECT data, output FROM pgboss.job`);
    const surfaces: Record<string, unknown> = { jobRows: jobs.rows, ...captured };
    return Object.entries(surfaces)
      .filter(([, value]) => (JSON.stringify(value) ?? "").includes(SENTINEL))
      .map(([name]) => name);
  }

  it("enqueues a metadata-only, singleton payload", async () => {
    await enqueueNewsRevalidation(appBoss, ids.userA);
    await enqueueNewsRevalidation(appBoss, ids.userA);

    const queued = await bootstrap.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND state = 'created'`,
      [NEWS_REVALIDATE_QUEUE]
    );
    expect(queued.rows).toHaveLength(1);
    const payload = queued.rows[0]!.data;
    expect(() => assertMetadataOnlyPayload(payload)).not.toThrow();
    expect(payload).toEqual({
      actorUserId: ids.userA,
      kind: "revalidate",
      idempotencyKey: `news-revalidate:${ids.userA}`
    });
  });

  it("revalidates drifted items and writes exactly one counts-only notification", async () => {
    await seedValidationRows("fp-old");
    await registerWorkers({ ai: makeWorkerAi({ fingerprint: "fp-new", allowed: false }) });
    await enqueueNewsRevalidation(appBoss, ids.userA);

    const visible = await waitFor(async () => {
      const listed = await asActor((db) => notifications.listVisible(db));
      return listed.notifications.length > 0 ? listed : null;
    }, "revalidation notification");

    expect(visible.notifications).toHaveLength(1);
    expect(visible.notifications[0]).toMatchObject({
      module_id: "news",
      title: "News sources need attention",
      body: "Open News settings to retry or remove them.",
      metadata: { kind: "news_revalidation", sourceCount: 1, topicCount: 1 }
    });
    // Counts only — the metadata must never carry labels or domains.
    expect(Object.keys(visible.notifications[0]!.metadata as object).sort()).toEqual([
      "kind",
      "sourceCount",
      "topicCount"
    ]);

    const sources = await asActor((db) => repository.listSourceValidationStates(db));
    const topics = await asActor((db) => repository.listTopicValidationStates(db));
    expect(sources).toMatchObject([
      { validationStatus: "rejected", validationFingerprint: "fp-new" }
    ]);
    expect(topics).toMatchObject([
      { validationStatus: "rejected", validationFingerprint: "fp-new" }
    ]);
  });

  it("does not notify again when a second run finds the same broken state", async () => {
    await seedValidationRows("fp-old");
    await registerWorkers({ ai: makeWorkerAi({ fingerprint: "fp-new", allowed: false }) });
    await enqueueNewsRevalidation(appBoss, ids.userA);
    await waitFor(
      async () => ((await countRevalidateJobs("completed")) >= 1 ? true : null),
      "first revalidation run"
    );

    await enqueueNewsRevalidation(appBoss, ids.userA);
    await waitFor(
      async () => ((await countRevalidateJobs("completed")) >= 2 ? true : null),
      "second revalidation run"
    );

    const listed = await asActor((db) => notifications.listVisible(db));
    expect(listed.notifications).toHaveLength(1);
  });

  it("still succeeds and logs when the notification write fails", async () => {
    await seedValidationRows("fp-old");
    const events: NewsRevalidationLogFields[] = [];
    await registerWorkers({
      ai: makeWorkerAi({ fingerprint: "fp-new", allowed: false }),
      notificationsRepository: {
        create: async () => {
          throw new Error("boom");
        }
      },
      revalidationLogger: { info: (fields) => events.push(fields) }
    });
    await enqueueNewsRevalidation(appBoss, ids.userA);

    await waitFor(
      async () => ((await countRevalidateJobs("completed")) >= 1 ? true : null),
      "revalidation run despite notification failure"
    );

    const sources = await asActor((db) => repository.listSourceValidationStates(db));
    expect(sources).toMatchObject([{ validationStatus: "rejected" }]);
    expect(events).toContainEqual({
      event: "news_notification_failed",
      error: "Error",
      message: "boom"
    });
    const listed = await asActor((db) => notifications.listVisible(db));
    expect(listed.notifications).toHaveLength(0);
  });

  it("refresh run enqueues revalidation when stored fingerprints drifted", async () => {
    await seedValidationRows("fp-old");
    await registerWorkers({ ai: makeWorkerAi({ fingerprint: "fp", allowed: true }) });
    await asActor((db) => repository.bumpRefreshRequest(db));
    await enqueueNewsRefresh(appBoss, ids.userA);

    await waitFor(
      async () => ((await countRevalidateJobs()) >= 1 ? true : null),
      "drift-triggered revalidation job"
    );
  });

  it("refresh run does not enqueue revalidation when fingerprints match", async () => {
    await seedValidationRows("fp");
    await registerWorkers({ ai: makeWorkerAi({ fingerprint: "fp", allowed: true }) });
    await asActor((db) => repository.bumpRefreshRequest(db));
    await enqueueNewsRefresh(appBoss, ids.userA);

    await waitFor(async () => {
      const state = await asActor((db) => repository.readRefreshState(db));
      return state.state === "idle" || state.state === "failed" ? true : null;
    }, "refresh run to settle");

    expect(await countRevalidateJobs()).toBe(0);
  });

  it("never leaks seeded private strings into job rows, logs, or notifications (Req C)", async () => {
    // #975 council re-run, Req C: the sentinel rides EVERY private input through the REAL
    // pipeline — seeded source label, topic label, topic guidance (seedValidationRows) and
    // the fetched article body (sentinelFetch) — while the drifted fingerprint + allowed:false
    // stub forces the maximal-output path: rejection writes AND the attention notification.
    await seedValidationRows("fp-old", { sentinel: SENTINEL });
    const workerLogs: unknown[] = [];
    const revalidationLogs: NewsRevalidationLogFields[] = [];
    await registerWorkers({
      ai: makeWorkerAi({ fingerprint: "fp-new", allowed: false }),
      fetch: sentinelFetch,
      logger: { info: (fields) => workerLogs.push(fields) },
      revalidationLogger: { info: (fields) => revalidationLogs.push(fields) }
    });
    await enqueueNewsRevalidation(appBoss, ids.userA);

    const visible = await waitFor(async () => {
      const listed = await asActor((db) => notifications.listVisible(db));
      return listed.notifications.length > 0 ? listed : null;
    }, "revalidation notification after sentinel run");

    // Non-vacuity anchors: prove the sentinel really was in the private inputs and the run
    // really processed them — otherwise an empty pipeline would pass the scan trivially.
    const sources = await asActor((db) => repository.listSourceValidationStates(db));
    const topics = await asActor((db) => repository.listTopicValidationStates(db));
    expect(sources[0]!.label).toContain(SENTINEL);
    expect(topics[0]!.label).toContain(SENTINEL);
    expect(topics[0]!.guidance).toContain(SENTINEL);
    expect(sources[0]!.validationStatus).toBe("rejected");
    expect(revalidationLogs).toContainEqual({
      event: "news_revalidation_run",
      sourcesChecked: 1,
      topicsChecked: 1,
      sourcesNeedingAttention: 1,
      topicsNeedingAttention: 1
    });

    // The scan proper: pg-boss data+output rows, both captured log streams, and the
    // owner-visible notification rows must all be sentinel-free.
    expect(
      await sentinelLeaks({
        workerLogs,
        revalidationLogs,
        notifications: visible.notifications
      })
    ).toEqual([]);
  });

  it("positive control: a deliberately leaked sentinel is caught on every surface", async () => {
    // Req C non-vacuity: prove sentinelLeaks actually detects leaks by planting the sentinel
    // on each surface the negative test scans.
    // (a) Job payload via raw appBoss.send — this bypasses sendJob's metadata-only guard,
    // which is exactly the path a regression would take (queues pre-exist via migratePgBoss,
    // and nothing else is enqueued here so the exclusive queue policy is not in play).
    await appBoss.send(NEWS_REVALIDATE_QUEUE, {
      actorUserId: ids.userA,
      kind: "revalidate",
      idempotencyKey: `news-revalidate:${ids.userA}`,
      leakedLabel: `The Example Times ${SENTINEL}`
    });
    // (b) A captured log line carrying private content.
    const revalidationLogs: unknown[] = [{ event: "debug", detail: `checking ${SENTINEL}` }];
    // (c) A notification whose body echoes the label — written under the worker role, the
    // same role the production revalidation path uses for its notification insert.
    await workerContext.withDataContext(
      { actorUserId: ids.userA, requestId: crypto.randomUUID() },
      (db) =>
        notifications.create(db, {
          moduleId: "news",
          title: "News sources need attention",
          body: `Your source "The Example Times ${SENTINEL}" was rejected.`,
          metadata: { kind: "news_revalidation" },
          urgency: "normal"
        })
    );

    const listed = await asActor((db) => notifications.listVisible(db));
    expect(await sentinelLeaks({ revalidationLogs, notifications: listed.notifications })).toEqual([
      "jobRows",
      "revalidationLogs",
      "notifications"
    ]);
  });
});

/**
 * Per-owner revalidation schedule (#975 Slice 4 Task 5): every personalization write funnels
 * through triggerNewsRefresh, which must reconcile a daily pgboss.schedule row — present while
 * the owner has any custom source/topic, absent once the last one is deleted. Assertions read
 * the real pgboss.schedule table (briefings F12 precedent), not a spy: grant 0002 gives the
 * app runtime role INSERT/DELETE on it even with the cron scheduler off in this process.
 */
describe("news revalidation schedule (#975 Slice 4)", () => {
  let appDb: Kysely<MossDatabase>;
  let appBoss: PgBoss;
  let bootstrap: pg.Client;

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    appBoss = createPgBossClient(connectionStrings.app);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await Promise.all([appBoss.start(), bootstrap.connect()]);
  });

  afterEach(async () => {
    await Promise.allSettled([appBoss.stop({ graceful: false }), appDb.destroy(), bootstrap.end()]);
  });

  // Preview-by-URL needs a feed with dated items (news-personalization-routes.test.ts feed).
  const PREVIEW_FEED = `<?xml version="1.0"?><rss><channel><title>Example News</title><item><title>Verified publisher headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

  function buildApp() {
    const app = Fastify();
    registerNewsPersonalizationRoutes(app, {
      dataContext: new DataContextRunner(appDb),
      resolveAccessContext: async (request) => ({
        actorUserId: String(request.headers["x-user-id"] ?? ids.userA),
        requestId: crypto.randomUUID()
      }),
      availability: { hasJsonModel: async () => true, hasWebSearch: async () => true },
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: PREVIEW_FEED,
          truncated: false
        }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "fp",
          generateJson: async (_db, input) => ({
            ok: true,
            object: input.prompt.includes("news TOPIC")
              ? { allowed: true, category: "news_topic" }
              : { allowed: true, category: "news_publisher" }
          })
        }
      },
      boss: appBoss,
      repository: new NewsPersonalizationRepository()
    });
    return app;
  }

  async function createSourceViaApi(app: ReturnType<typeof buildApp>): Promise<string> {
    const preview = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "https://example.com/feed.xml" }
    });
    expect(preview.statusCode).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/news/sources",
      payload: { confirmationId: JSON.parse(preview.body).confirmationId }
    });
    expect(confirmed.statusCode).toBe(201);
    return JSON.parse(confirmed.body).source.id as string;
  }

  async function createTopicViaApi(app: ReturnType<typeof buildApp>): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/news/topics",
      payload: { label: "AI Safety", guidance: "focus on policy" }
    });
    expect(created.statusCode).toBe(201);
    return JSON.parse(created.body).topic.id as string;
  }

  async function scheduleRows(): Promise<
    { key: string; cron: string; timezone: string; data: Record<string, unknown> }[]
  > {
    const result = await bootstrap.query<{
      key: string;
      cron: string;
      timezone: string;
      data: Record<string, unknown>;
    }>(`SELECT key, cron, timezone, data FROM pgboss.schedule WHERE name = $1 ORDER BY key`, [
      NEWS_REVALIDATE_QUEUE
    ]);
    return result.rows;
  }

  it("schedules a daily metadata-only revalidation row when the first source is created", async () => {
    const app = buildApp();
    await app.ready();
    try {
      expect(await scheduleRows()).toHaveLength(0);
      await createSourceViaApi(app);

      const rows = await scheduleRows();
      expect(rows).toHaveLength(1);
      // Schedule key is the bare owner id — pg-boss rejects colons in schedule keys
      // (attorney assertKey: [alnum_.-/] only), so the colon form lives in the payload only.
      expect(rows[0]).toMatchObject({ key: ids.userA, cron: "43 4 * * *", timezone: "UTC" });
      // The cron payload bypasses sendJob's guard, so prove it is metadata-only here too.
      expect(() => assertMetadataOnlyPayload(rows[0]!.data)).not.toThrow();
      expect(rows[0]!.data).toEqual({
        actorUserId: ids.userA,
        kind: "revalidate",
        idempotencyKey: `news-revalidate:${ids.userA}`
      });
    } finally {
      await app.close();
    }
  });

  it("unschedules only when the last source AND topic are deleted", async () => {
    const app = buildApp();
    await app.ready();
    try {
      const sourceId = await createSourceViaApi(app);
      const topicId = await createTopicViaApi(app);
      expect(await scheduleRows()).toHaveLength(1);

      const topicGone = await app.inject({ method: "DELETE", url: `/api/news/topics/${topicId}` });
      expect(topicGone.statusCode).toBe(200);
      // A source remains — the daily check must survive.
      expect(await scheduleRows()).toHaveLength(1);

      const sourceGone = await app.inject({
        method: "DELETE",
        url: `/api/news/sources/${sourceId}`
      });
      expect(sourceGone.statusCode).toBe(200);
      expect(await scheduleRows()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("does not fail the write route when boss.schedule throws (best-effort)", async () => {
    const app = buildApp();
    await app.ready();
    const originalSchedule = appBoss.schedule.bind(appBoss);
    appBoss.schedule = (async () => {
      throw new Error("pg-boss schedule unavailable");
    }) as typeof appBoss.schedule;
    try {
      await createSourceViaApi(app); // asserts 201 internally
      // The refresh enqueue after the failed reconcile must still happen.
      const refreshJobs = await bootstrap.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'news.refresh'`
      );
      expect(refreshJobs.rows[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      appBoss.schedule = originalSchedule;
      await app.close();
    }
  });
});
