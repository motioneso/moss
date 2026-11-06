import { randomUUID } from "node:crypto";

import { AiRepository, createPlatformDiagnosticsService } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { readConnectionDiagnostics } from "@moss/connectors";
import { createPgBossClient, readJobDiagnostics } from "@moss/jobs";
import { createNewsDiagnosticsProvider } from "@moss/news";
import { SettingsRepository } from "@moss/settings";
import type { HostDiagnosticsDto } from "@moss/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";

const runtime = {
  uptimeSeconds: 10,
  environment: "test",
  version: "1.2.3",
  commit: "abc123",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "info",
  deployMode: "dev",
  restartCommand: null,
  moduleCount: 2,
  routeCount: 3,
  multiplexer: "auto",
  available: { tmux: false, herdr: false },
  checks: [],
  latestAvailableVersion: null,
  releaseNotes: null
} as HostDiagnosticsDto;

describe("platform diagnostics", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const aiRepository = new AiRepository();
  const newsRepository = new NewsPersonalizationRepository();
  const settingsRepository = new SettingsRepository();
  const droppedProviders: string[][] = [];

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  async function seedActor(actorUserId: string, itemCount: number): Promise<void> {
    await dataContext.withDataContext(
      { actorUserId, requestId: `seed-${actorUserId}` },
      async (db) => {
        await aiRepository.recordError(db, {
          id: randomUUID(),
          feature: `feature-${actorUserId}`,
          operation: "refresh",
          errorCategory: "temporary",
          retryable: true,
          userMessage: `message-${actorUserId}`,
          internalSummary: `summary-${actorUserId}`,
          requestId: `request-${actorUserId}`
        });
        await aiRepository.insertActionAuditLog(db, {
          id: randomUUID(),
          ownerUserId: actorUserId,
          toolModuleId: "news",
          toolName: "news.refreshNews",
          actionFamilyId: "news-refresh",
          actionKind: "write",
          approvalMode: "auto",
          outcome: "success",
          durationMs: null,
          errorClass: null,
          requestId: `request-${actorUserId}`,
          chatSessionId: null,
          sourceSurface: "chat",
          inputSummary: { inputKeys: ["source"], inputKeyCount: 1, truncated: false }
        });
        const generation = await newsRepository.bumpRefreshRequest(db);
        await newsRepository.publishSnapshotIfCurrent(db, generation, {
          compiledAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          payload: {
            articles: Array.from({ length: itemCount }, (_, index) => ({
              id: `${actorUserId}-${index}`,
              publisher: "Example Publisher",
              canonicalDomain: "example.test",
              headline: `private headline ${actorUserId}`,
              url: `https://example.test/${index}`,
              publishedAt: "2026-08-27T10:00:00.000Z",
              excerpt: null,
              imageUrl: null,
              topics: [],
              preferred: true,
              rank: index + 1
            }))
          }
        });
      }
    );
  }

  function service() {
    return createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "build-version", buildId: "build-id" }) },
      collectHostDiagnostics: async () => runtime,
      repository: aiRepository,
      moduleProviders: async () => [
        { moduleId: "news", provider: createNewsDiagnosticsProvider(newsRepository) },
        {
          moduleId: "broken",
          provider: {
            domain: "news",
            providerId: "news.broken",
            observe: async () => {
              const error = new Error("provider payload must not be logged");
              error.name = "ProviderFailure";
              throw error;
            }
          }
        }
      ],
      runInContext: (work, context) =>
        dataContext.withDataContext(
          { actorUserId: context.actorUserId, requestId: context.requestId },
          work
        ),
      isInstanceAdmin: async (db, actorUserId) =>
        (await settingsRepository.getUserById(db, actorUserId))?.is_instance_admin === true,
      assertDiagnosticsSafe: () => undefined,
      readJobs: (db, ctx, opts) =>
        readJobDiagnostics(db.db, { ...opts, actorUserId: ctx.actorUserId }),
      readConnections: (db, _ctx, opts) => readConnectionDiagnostics(db, opts),
      onProviderError: (moduleId, errorName) => droppedProviders.push([moduleId, errorName])
    });
  }

  it("shows runtime only to admins and keeps all actor-owned sections isolated", async () => {
    await seedActor(ids.userA, 1);
    await seedActor(ids.userB, 2);
    const diagnostics = service();

    const userReport = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "report-a" },
      (db) => diagnostics.observe(db, { actorUserId: ids.userA, requestId: "report-a" })
    );
    const adminReport = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "report-admin" },
      (db) => diagnostics.observe(db, { actorUserId: ids.adminUser, requestId: "report-admin" })
    );

    expect(userReport.runtime).toBeNull();
    expect(userReport.redactions).toContain("runtime");
    expect(userReport.errors[0]?.feature).toBe(`feature-${ids.userA}`);
    expect(userReport.errors.map((row) => row.feature)).not.toContain(`feature-${ids.userB}`);
    expect(userReport.actions[0]?.toolModuleId).toBe("news");
    expect(userReport.modules[0]?.facts?.itemCount).toBe(1);
    expect(JSON.stringify(userReport)).not.toContain(ids.userB);
    expect(JSON.stringify(userReport)).not.toContain("private headline");
    expect(adminReport.runtime).toBe(runtime);
    expect(droppedProviders).toContainEqual(["broken", "ProviderFailure"]);
  });

  describe("jobs and connections sections", () => {
    const QUEUE = "diag.platform-queue";

    async function bootstrap(text: string, values: unknown[] = []): Promise<void> {
      const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(text, values);
      } finally {
        await client.end();
      }
    }

    async function observeAs(actor: string, include: ("jobs" | "connections")[]) {
      return dataContext.withDataContext({ actorUserId: actor, requestId: "jobs-1" }, (db) =>
        service().observe(db, { actorUserId: actor, requestId: "jobs-1" }, { include })
      );
    }

    beforeAll(async () => {
      const boss = createPgBossClient(connectionStrings.worker, {
        connectionTimeoutMillis: 25_000
      });
      await boss.start();
      await boss.createQueue(QUEUE);
      await boss.stop({ graceful: false });
      await bootstrap("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
      for (const [actor, kind] of [
        [ids.adminUser, "admin-kind"],
        [ids.userB, "second-admin-kind"]
      ]) {
        await bootstrap(
          `INSERT INTO pgboss.job (name, data, state, completed_on)
           VALUES ($1, $2::jsonb, 'failed', now())`,
          [QUEUE, JSON.stringify({ actorUserId: actor, kind })]
        );
      }
      await bootstrap("UPDATE app.users SET is_instance_admin = true WHERE id = $1", [ids.userB]);
    });

    afterAll(async () => {
      await bootstrap("UPDATE app.users SET is_instance_admin = false WHERE id = $1", [ids.userB]);
      await bootstrap("DELETE FROM pgboss.job WHERE name = $1", [QUEUE]);
    });

    it("gives a non-admin redactions and no job data", async () => {
      const report = await observeAs(ids.userA, ["jobs", "connections"]);
      expect(report.redactions).toEqual(expect.arrayContaining(["jobs", "connections"]));
      expect(report.jobs).toEqual({ recent: [], summaries: [], truncated: false });
      expect(JSON.stringify(report)).not.toContain("admin-kind");
    });

    it("lets each admin see their own job detail and only the allowlist for the other's", async () => {
      const first = await observeAs(ids.adminUser, ["jobs"]);
      const second = await observeAs(ids.userB, ["jobs"]);
      const firstText = JSON.stringify(first.jobs);
      const secondText = JSON.stringify(second.jobs);
      expect(firstText).toContain("admin-kind");
      expect(firstText).not.toContain("second-admin-kind");
      expect(secondText).toContain("second-admin-kind");
      expect(secondText).not.toContain('"admin-kind"');
      expect(first.redactions).not.toContain("jobs");
    });
  });
});
