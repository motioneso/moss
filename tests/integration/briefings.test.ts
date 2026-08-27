import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { AiRepository, createAiSecretCipher } from "@moss/ai";
import {
  BRIEFINGS_RUN_QUEUE,
  briefingsModuleManifest,
  isBriefingRunPayloadMetadataOnly,
  reconcileSchedule,
  registerBriefingsRoutes,
  type BriefingRunPayload,
  type BriefingsRepository
} from "@moss/briefings";
import type {
  AccessContext,
  AuthSessionResolver,
  BriefingDefinition,
  DataContextDb,
  DataContextRunner,
  SharesRepository,
  MossDatabase
} from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  getBuiltInSqlMigrationDirectories
} from "@moss/module-registry";
import { briefingRunPayloadSchema } from "@moss/shared";
import { SOURCE_BEHAVIOR_PREFERENCE_KEY } from "@moss/source-behaviors";
import { PreferencesRepository } from "@moss/structured-state";
import { connectionStrings, expectedBuiltInModuleIds, ids } from "./test-database.js";
import {
  briefingIds,
  countPgBossJobs,
  handleNextBriefingJob,
  makeComposeDeps,
  setupBriefingsHarness,
  sourceIds,
  adminContext,
  spyBossSchedule,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

const { Client } = pg;

describe("Briefings module M6 read-only scheduled summaries", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let repository: BriefingsRepository;
  let sharesRepository: SharesRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    auth = harness.auth;
    dataContext = harness.dataContext;
    repository = harness.repository;
    sharesRepository = harness.sharesRepository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
  });

  afterAll(async () => {
    await teardownBriefingsHarness({
      server,
      appBoss,
      workerBoss,
      appDb,
      workerDb
    });
  });

  it("applies Briefings migrations with forced RLS and narrow worker table grants", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          WHERE version = '0015'
          ORDER BY version
        `
      );
      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
        worker_can_delete: boolean;
        worker_can_insert: boolean;
        worker_can_select: boolean;
        worker_can_update: boolean;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE') AS worker_can_delete,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'INSERT') AS worker_can_insert,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'SELECT') AS worker_can_select,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'UPDATE') AS worker_can_update
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN ('briefing_definitions', 'briefing_runs')
          ORDER BY c.relname
        `
      );

      expect(migrations.rows).toEqual([{ version: "0015", name: "0015_briefings_module.sql" }]);
      expect(tables.rows).toEqual([
        {
          relname: "briefing_definitions",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_can_delete: false,
          worker_can_insert: false,
          worker_can_select: true,
          worker_can_update: true
        },
        {
          relname: "briefing_runs",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_can_delete: false,
          worker_can_insert: true,
          worker_can_select: true,
          worker_can_update: false
        }
      ]);
    } finally {
      await client.end();
    }
  });

  it("loads Briefings as a required built-in module with a metadata-only run queue", () => {
    const manifests = getBuiltInModuleManifests();
    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === briefingsModuleManifest.id
    );

    expect(manifests.map((item) => item.id)).toEqual(expectedBuiltInModuleIds);
    expect(registration?.manifest.database?.ownedTables).toEqual([
      "app.briefing_definitions",
      "app.briefing_runs"
    ]);
    expect(registration?.manifest.database?.migrations).toContain("sql/0116_briefing_type.sql");
    expect(registration?.manifest.navigation?.[0]).toMatchObject({
      id: "briefings",
      path: "/briefings",
      permissionId: "briefings.view"
    });
    expect(registration?.manifest.jobs?.[0]).toMatchObject({
      queueName: BRIEFINGS_RUN_QUEUE,
      metadataOnly: true,
      permissionId: "briefings.run"
    });
    expect(briefingRunPayloadSchema.required).toContain("briefingType");
    expect(briefingRunPayloadSchema.properties.briefingType).toEqual({
      type: "string",
      enum: ["morning", "evening", "weekly_review"]
    });
    expect(registration?.queueDefinitions.map((queue) => queue.name)).toEqual([
      BRIEFINGS_RUN_QUEUE
    ]);
    // #2013 registers workflows after people, so it now runs last.
    expect(getBuiltInSqlMigrationDirectories().at(-1)).toContain("packages/workflows/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-2)).toContain("packages/people/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-3)).toContain("packages/commitments/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-4)).toContain("packages/proactive-monitoring");
    expect(getBuiltInSqlMigrationDirectories().at(-5)).toContain("packages/notes/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-6)).toContain("packages/news/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-7)).toContain("packages/sports/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-8)).toContain("packages/wellness/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-9)).toContain("packages/structured-state/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-10)).toContain(
      "packages/usefulness-feedback/sql"
    );
    expect(getBuiltInSqlMigrationDirectories().at(-11)).toContain("packages/memory/sql");
    expect(getBuiltInSqlMigrationDirectories().at(-12)).toContain("packages/briefings/sql");
  });

  it("keeps definitions private by default and denies admin private-data bypass", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "User A private briefing",
        selectedToolNames: ["tasks.list"]
      })
    );
    const userARead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getDefinitionById(scopedDb, created.id)
    );
    const userBRead = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getDefinitionById(scopedDb, created.id)
    );
    const adminContext = await auth.resolveAccessContext(
      ids.sessionAdmin,
      "request:admin-briefings"
    );
    const adminRead = await dataContext.withDataContext(adminContext, (scopedDb) =>
      repository.getDefinitionById(scopedDb, briefingIds.userBPrivate)
    );

    expect(created.owner_user_id).toBe(ids.userA);
    expect(created.briefing_type).toBe("morning");
    expect(userARead?.id).toBe(created.id);
    expect(userBRead).toBeUndefined();
    expect(adminRead).toBeUndefined();
  });

  it("share grantee can see the definition but NOT its runs; runs stay owner-only", async () => {
    // Use userBWorkspace definition to avoid polluting the worker-isolation test below
    // userA cannot see userB's workspace definition or its runs before share grant
    const defBeforeShare = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getDefinitionById(scopedDb, briefingIds.userBWorkspace)
    );
    expect(defBeforeShare).toBeUndefined();

    // Create a run for userB's workspace briefing as owner
    const outcome = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.generateRun(scopedDb, briefingIds.userBWorkspace, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps()
      })
    );
    const run = outcome?.run;
    expect(run?.id).toBeTruthy();

    const runsBeforeShare = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listRuns(scopedDb, briefingIds.userBWorkspace)
    );
    expect(runsBeforeShare).toEqual([]);

    // userB grants userA 'view' access to the definition
    await dataContext.withDataContext(userBContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "briefing_definition",
        resourceId: briefingIds.userBWorkspace,
        ownerUserId: ids.userB,
        granteeUserId: ids.userA,
        level: "view"
      })
    );

    // userA can now see the definition via share — but the RUN CONTENT (grounded
    // summary derived from userB's private data) stays owner-only (migration 0085).
    // Definition sharing must NOT silently leak run output to a view-grantee.
    const defAfterShare = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getDefinitionById(scopedDb, briefingIds.userBWorkspace)
    );
    const runsAfterShare = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listRuns(scopedDb, briefingIds.userBWorkspace)
    );
    expect(defAfterShare?.id).toBe(briefingIds.userBWorkspace);
    expect(runsAfterShare).toEqual([]);
    expect(runsAfterShare.some((r) => r.id === run?.id)).toBe(false);

    // The owner still reads their own runs after sharing the definition.
    const ownerRunsAfterShare = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listRuns(scopedDb, briefingIds.userBWorkspace)
    );
    expect(ownerRunsAfterShare.some((r) => r.id === run?.id)).toBe(true);
  });

  it("synthesizes a run through declared read-only tools and leaks no source secrets", async () => {
    // Configure an economy model so compose takes the synthesis path (not the degraded
    // fallback). The injected fake adapter returns the fixed "synth narrative".
    const aiRepository = new AiRepository();
    const provider = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      aiRepository.createProvider(scopedDb, {
        providerKind: "anthropic",
        displayName: "Synthesis summarizer",
        encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "briefing-synth-key" })
      })
    );
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      aiRepository.createModel(scopedDb, {
        providerConfigId: provider.id,
        providerModelId: "synth-summarizer",
        displayName: "Synthesis Summarizer",
        capabilities: ["summarization"],
        tier: "economy"
      })
    );

    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Morning briefing",
        selectedToolNames: ["tasks.list", "email.listVisibleMessages"]
      })
    );
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps(async () => ({ text: "synth narrative" }))
      })
    );
    const run = outcome?.run;
    const serialized = JSON.stringify(run);
    const meta = run?.source_metadata as {
      degraded: boolean;
      taskCount: number;
      emailCount: number;
    };

    expect(outcome?.created).toBe(true);
    expect(run?.status).toBe("succeeded");
    expect(run?.summary_text).toBe("synth narrative");
    expect(meta.degraded).toBe(false);
    expect(meta.taskCount).toBeGreaterThanOrEqual(1);
    expect(typeof meta.emailCount).toBe("number");
    // RLS + provenance: no other user's private rows and no connector ciphertext leak.
    expect(serialized).not.toContain("User B private");
    expect(serialized).not.toContain("briefing-hidden-ciphertext");
    expect(serialized).not.toContain("encrypted_secret");
    expect(serialized).not.toContain("ciphertext");
  });

  it("omits email from generated briefings when the user disables that source behavior", async () => {
    const prefs = new PreferencesRepository();
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      prefs.upsert(scopedDb, SOURCE_BEHAVIOR_PREFERENCE_KEY, { "email.briefings": false })
    );
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Policy-filtered briefing",
        selectedToolNames: ["tasks.list", "email.listVisibleMessages"]
      })
    );
    const outcome = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps()
      })
    );
    const run = outcome?.run;
    const meta = run?.source_metadata as { emailCount: number };

    expect(outcome?.created).toBe(true);
    expect(meta.emailCount).toBe(0);
    expect(JSON.stringify(run)).not.toContain("User A briefing email");
  });

  it("rejects write tool names and does not mutate source modules or enqueue jobs", async () => {
    const jobsBefore = await countPgBossJobs();
    const response = await server.inject({
      method: "POST",
      url: "/api/briefings/definitions",
      headers: userAHeaders(),
      payload: {
        title: "Invalid write briefing",
        selectedToolNames: ["tasks.updateStatus"]
      }
    });
    const jobsAfter = await countPgBossJobs();
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.tasks")
        .select(["id", "status"])
        .where("id", "=", sourceIds.userATask)
        .executeTakeFirst()
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Briefings can only select declared read-risk assistant tools"
    });
    expect(task?.status).toBe("todo");
    expect(jobsAfter).toBe(jobsBefore);
  });

  it("rejects an invalid timezone in scheduleMetadata with 400", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/briefings/definitions",
      headers: userAHeaders(),
      payload: {
        title: "Bad timezone briefing",
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:00", timezone: "Not/A/Timezone" },
        selectedToolNames: ["tasks.list"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid timezone" });
  });

  it("rejects weekly cadence without dayOfWeek with 400", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/briefings/definitions",
      headers: userAHeaders(),
      payload: {
        title: "Weekly no dow briefing",
        cadence: "weekly",
        scheduleMetadata: { targetTime: "09:00", timezone: "UTC" },
        selectedToolNames: ["tasks.list"]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "dayOfWeek required for weekly schedules" });
  });

  it("queues run-now jobs with metadata-only payloads and worker-created RLS summaries", async () => {
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Worker briefing",
        selectedToolNames: ["tasks.list"]
      })
    );
    const resultPromise = handleNextBriefingJob(workerBoss);
    const response = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: {
        idempotencyKey: "briefing-worker-test"
      }
    });
    const responseBody = response.json<{ jobId: string; runId: string }>();
    const result = await resultPromise;
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const payloads = await client.query<{ data: Record<string, unknown> }>(
        `
          SELECT data
          FROM pgboss.job_common
          WHERE name = $1
          ORDER BY created_on DESC
          LIMIT 1
        `,
        [BRIEFINGS_RUN_QUEUE]
      );
      const payload = payloads.rows[0]?.data;

      expect(response.statusCode).toBe(202);
      expect(responseBody.jobId).toBeTruthy();
      expect(result).toMatchObject({
        definitionId: definition.id,
        runId: responseBody.runId,
        status: "succeeded"
      });
      expect(payload).toEqual({
        actorUserId: ids.userA,
        definitionId: definition.id,
        briefingRunId: responseBody.runId,
        runKind: "manual",
        briefingType: "morning",
        idempotencyKey: "briefing-worker-test"
      });
      expect(isBriefingRunPayloadMetadataOnly(payload ?? {})).toBe(true);
      expect(JSON.stringify(payload)).not.toContain("User A briefing task");
      expect(JSON.stringify(payload)).not.toContain("summary");
      expect(JSON.stringify(payload)).not.toContain("prompt");
      expect(JSON.stringify(payload)).not.toContain("ciphertext");
    } finally {
      await client.end();
    }
  });

  it("authorizes run-now through the owner-scoped repository lookup", async () => {
    const routeDefinition: BriefingDefinition = {
      id: "77000000-0000-4000-8000-000000000150",
      owner_user_id: ids.userA,
      title: "Owner-scoped route briefing",
      briefing_type: "morning",
      cadence: "manual",
      schedule_metadata: {},
      enabled: true,
      selected_tool_names: ["tasks.list"],
      last_run_at: null,
      created_at: new Date("2026-06-16T12:00:00.000Z"),
      updated_at: new Date("2026-06-16T12:00:00.000Z")
    };
    const getDefinitionById = vi.fn(async () => {
      throw new Error("route must not use shared definition lookup for run authorization");
    });
    const getOwnedDefinitionById = vi.fn(async () => routeDefinition);
    const bossSend = vi.fn(async () => "job-route-owner-lookup");
    const routeServer = Fastify({ logger: false });

    registerBriefingsRoutes(routeServer, {
      resolveAccessContext: async () => ({
        actorUserId: ids.userA,
        requestId: "request:route-owner-lookup"
      }),
      dataContext: {
        withDataContext: async <T>(
          _ctx: AccessContext,
          work: (scopedDb: DataContextDb) => Promise<T>
        ) => work({} as DataContextDb)
      } as unknown as DataContextRunner,
      listModuleManifests: () => [],
      boss: { send: bossSend } as unknown as PgBoss,
      repository: {
        getDefinitionById,
        getOwnedDefinitionById
      } as unknown as BriefingsRepository
    });
    await routeServer.ready();

    try {
      const response = await routeServer.inject({
        method: "POST",
        url: `/api/briefings/definitions/${routeDefinition.id}/run`,
        headers: userAHeaders(),
        payload: { idempotencyKey: "owner-scoped-route-lookup" }
      });

      expect(response.statusCode).toBe(202);
      expect(getOwnedDefinitionById).toHaveBeenCalledWith(expect.anything(), routeDefinition.id);
      expect(getDefinitionById).not.toHaveBeenCalled();
      expect(bossSend).toHaveBeenCalledWith(
        BRIEFINGS_RUN_QUEUE,
        expect.objectContaining({
          actorUserId: ids.userA,
          definitionId: routeDefinition.id,
          runKind: "manual",
          briefingType: "morning",
          idempotencyKey: "owner-scoped-route-lookup"
        }),
        expect.objectContaining({
          singletonKey: `${routeDefinition.id}:key:owner-scoped-route-lookup`
        })
      );
    } finally {
      await routeServer.close();
    }
  });

  it("dedupes concurrent run-now submits sharing an idempotency key (#150)", async () => {
    // A double-submit (retry / double-click) before the worker consumes must
    // collapse to ONE queued job. pg-boss returns null on the singletonKey
    // collision; the route surfaces that as 409 (already queued), not a 500.
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Idempotency briefing",
        selectedToolNames: ["tasks.list"]
      })
    );
    const idempotencyKey = "briefing-idempotency-dedupe-test";

    const first = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: { idempotencyKey }
    });
    const second = await server.inject({
      method: "POST",
      url: `/api/briefings/definitions/${definition.id}/run`,
      headers: userAHeaders(),
      payload: { idempotencyKey }
    });

    expect(first.statusCode).toBe(202);
    expect(first.json<{ jobId: string }>().jobId).toBeTruthy();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: "A briefing run with this idempotency key is already queued or running"
    });

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const counted = await client.query<{ count: string }>(
        `
          SELECT count(*) AS count
          FROM pgboss.job_common
          WHERE name = $1 AND data->>'idempotencyKey' = $2
        `,
        [BRIEFINGS_RUN_QUEUE, idempotencyKey]
      );
      expect(counted.rows[0]?.count).toBe("1");
    } finally {
      await client.end();
    }

    // Drain the single queued job so it can't leak into later worker assertions.
    await handleNextBriefingJob(workerBoss);
  });

  it("reconciles the pg-boss schedule on create (daily enabled → boss.schedule keyed by id)", async () => {
    const calls = spyBossSchedule(appBoss);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/briefings/definitions",
        headers: userAHeaders(),
        payload: {
          title: "Scheduled morning briefing",
          cadence: "daily",
          scheduleMetadata: { targetTime: "06:00", timezone: "America/New_York" },
          enabled: true,
          selectedToolNames: ["tasks.list"]
        }
      });

      expect(response.statusCode).toBe(201);
      const definition = response.json<{ definition: { id: string } }>().definition;
      expect(calls.unschedule).toHaveLength(0);
      const scheduled = calls.schedule.filter((c) => c.key === definition.id);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({
        name: BRIEFINGS_RUN_QUEUE,
        cron: "0 6 * * *",
        tz: "America/New_York",
        key: definition.id,
        data: {
          actorUserId: ids.userA,
          definitionId: definition.id,
          runKind: "scheduled",
          briefingType: "morning"
        }
      });
    } finally {
      calls.restore();
    }
  });

  it("reconciles the pg-boss schedule on update to enabled:false (→ boss.unschedule)", async () => {
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Toggle-off briefing",
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:30", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );

    const calls = spyBossSchedule(appBoss);
    try {
      const response = await server.inject({
        method: "PATCH",
        url: `/api/briefings/definitions/${definition.id}`,
        headers: userAHeaders(),
        payload: { enabled: false }
      });

      expect(response.statusCode).toBe(200);
      expect(calls.schedule).toHaveLength(0);
      expect(calls.unschedule).toEqual([{ name: BRIEFINGS_RUN_QUEUE, key: definition.id }]);
    } finally {
      calls.restore();
    }
  });

  it("does not fail the create request when schedule reconcile throws (failure-isolated)", async () => {
    const originalSchedule = appBoss.schedule.bind(appBoss);
    appBoss.schedule = (async () => {
      throw new Error("pg-boss schedule unavailable");
    }) as typeof appBoss.schedule;
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/briefings/definitions",
        headers: userAHeaders(),
        payload: {
          title: "Reconcile-failure briefing",
          cadence: "daily",
          scheduleMetadata: { targetTime: "08:00", timezone: "UTC" },
          enabled: true,
          selectedToolNames: ["tasks.list"]
        }
      });

      // The mutation succeeded even though reconcile threw — reconcile is best-effort.
      expect(response.statusCode).toBe(201);
      expect(response.json<{ definition: { id: string } }>().definition.id).toBeTruthy();
    } finally {
      appBoss.schedule = originalSchedule;
    }
  });

  it("self-heals the owner's schedules on GET list and stays 200 even when reconcile throws", async () => {
    // Ensure at least one enabled daily definition owned by user A exists so the
    // best-effort self-heal has something to reconcile.
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Self-heal target",
        cadence: "daily",
        scheduleMetadata: { targetTime: "06:15", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );

    const calls = spyBossSchedule(appBoss);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/briefings/definitions",
        headers: userAHeaders()
      });

      expect(response.statusCode).toBe(200);
      // List response shape is unchanged.
      const body = response.json<{ definitions: Array<{ id: string }> }>();
      expect(Array.isArray(body.definitions)).toBe(true);

      // The self-heal is fire-and-forget; give the microtask/IO a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 50));
      // At least one enabled daily definition owned by user A was (re)scheduled.
      expect(calls.schedule.length).toBeGreaterThanOrEqual(1);
    } finally {
      calls.restore();
    }
  });

  it("keeps distinct per-definition schedule rows under the exclusive run queue (F12)", async () => {
    // Two DIFFERENT enabled daily definitions owned by user A. The BRIEFINGS_RUN_QUEUE
    // policy is `exclusive` (NULL singletonKeys collapse to one job), but pg-boss
    // SCHEDULES are keyed independently — pgboss.schedule is PRIMARY KEY (name, key),
    // and reconcileSchedule keys on definition.id — so both must co-exist.
    const defA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Schedule rows A",
        cadence: "daily",
        scheduleMetadata: { targetTime: "06:00", timezone: "America/New_York" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );
    const defB = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Schedule rows B",
        cadence: "daily",
        scheduleMetadata: { targetTime: "07:30", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );

    // Build a REAL cron-enabled boss (the worker's mode) so boss.schedule writes
    // actual pgboss.schedule rows — not a spy.
    const scheduleBoss = createPgBossClient(connectionStrings.worker, { schedule: true });
    await scheduleBoss.start();
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      await reconcileSchedule(scheduleBoss, defA);
      await reconcileSchedule(scheduleBoss, defB);

      const bothRows = await client.query<{ name: string; key: string }>(
        `SELECT name, key FROM pgboss.schedule WHERE name = $1 AND key = ANY($2::text[]) ORDER BY key`,
        [BRIEFINGS_RUN_QUEUE, [defA.id, defB.id]]
      );
      const keys = bothRows.rows.map((r) => r.key).sort();
      expect(keys).toEqual([defA.id, defB.id].sort());

      // Disabling one definition removes ONLY its schedule row (the other survives).
      await reconcileSchedule(scheduleBoss, { ...defA, enabled: false });
      const afterDisable = await client.query<{ key: string }>(
        `SELECT key FROM pgboss.schedule WHERE name = $1 AND key = ANY($2::text[])`,
        [BRIEFINGS_RUN_QUEUE, [defA.id, defB.id]]
      );
      const remaining = afterDisable.rows.map((r) => r.key);
      expect(remaining).toEqual([defB.id]);
    } finally {
      await client.end();
      // Clean up B's surviving schedule so it can't fire into later worker assertions.
      await reconcileSchedule(scheduleBoss, { ...defB, enabled: false });
      await scheduleBoss.stop({ graceful: false });
    }
  });

  it("API-process boss (schedule:false, app runtime role) can write+delete pgboss.schedule rows (grant 0002)", async () => {
    // The existing route/reconcile assertions are best-effort and FAILURE-ISOLATED:
    // the create route swallows a thrown reconcile (proven above), and the F12 row
    // assertions run through a `schedule:true` WORKER-role boss. Neither proves the
    // *API process* path — `appBoss` is built from connectionStrings.app
    // (jarvis_app_runtime) with the default schedule:false, exactly as apps/api wires
    // it — actually has the pgboss.schedule INSERT/DELETE privilege granted in
    // infra/postgres/grants/0002_pgboss_cron_owner_grants.sql. If that grant were
    // missing or revoked, the route path would silently swallow the permission error;
    // this test calls reconcileSchedule against the real app-role boss with NO
    // try/catch, so an insufficient runtime grant surfaces as a thrown error here.
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "API-process schedule grant probe",
        cadence: "daily",
        scheduleMetadata: { targetTime: "05:45", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.list"]
      })
    );

    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      // INSERT path through jarvis_app_runtime — must not throw, and the row must land.
      await reconcileSchedule(appBoss, definition);
      const afterEnable = await client.query<{ key: string }>(
        `SELECT key FROM pgboss.schedule WHERE name = $1 AND key = $2`,
        [BRIEFINGS_RUN_QUEUE, definition.id]
      );
      expect(afterEnable.rows.map((r) => r.key)).toEqual([definition.id]);

      // DELETE path through jarvis_app_runtime (enabled:false → boss.unschedule) —
      // must not throw, and the row must be gone.
      await reconcileSchedule(appBoss, { ...definition, enabled: false });
      const afterDisable = await client.query<{ key: string }>(
        `SELECT key FROM pgboss.schedule WHERE name = $1 AND key = $2`,
        [BRIEFINGS_RUN_QUEUE, definition.id]
      );
      expect(afterDisable.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does not let a User A worker job run User B's private briefing", async () => {
    const resultPromise = handleNextBriefingJob(workerBoss);

    // Keyless send is safe here only because this is the sole keyless enqueue against
    // the exclusive run queue in this suite — under `exclusive` policy all NULL
    // singletonKeys collapse to one job (COALESCE(singleton_key,'')), so any second
    // keyless send would dedupe against this one. Add an explicit singletonKey if a
    // future test enqueues another keyless run-now job here.
    await appBoss.send(BRIEFINGS_RUN_QUEUE, {
      actorUserId: ids.userA,
      definitionId: briefingIds.userBPrivate,
      briefingRunId: "7c000000-0000-4000-8000-000000000001",
      runKind: "manual",
      briefingType: "morning",
      idempotencyKey: "briefing-denied-worker-test"
    } satisfies BriefingRunPayload);

    const result = await resultPromise;
    const userBPrivateRuns = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listRuns(scopedDb, briefingIds.userBPrivate)
    );

    expect(result).toEqual({
      definitionId: briefingIds.userBPrivate,
      runId: "7c000000-0000-4000-8000-000000000001",
      status: null,
      created: false
    });
    expect(userBPrivateRuns).toEqual([]);
  });

  it("dedupes a blocked SCHEDULED run within the same local day (no orphan blocked rows)", async () => {
    // A scheduled definition whose selected tools are NOT all read tools must still honor
    // same-local-day idempotency: the blocked-tool guard now runs AFTER the scheduled
    // local-day check, so the first cron fire persists ONE `blocked` run and every later
    // fire that day dedupes against it (created:false) instead of orphaning a fresh
    // blocked row per tick. Build the definition directly via the repo (the blocked-tool
    // selection bypasses the route's read-only validation) using a write-risk tool name.
    const definition = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Blocked scheduled briefing",
        cadence: "daily",
        scheduleMetadata: { targetTime: "06:00", timezone: "UTC" },
        enabled: true,
        selectedToolNames: ["tasks.updateStatus"]
      })
    );

    const first = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "scheduled",
        composeDeps: makeComposeDeps()
      })
    );
    expect(first?.created).toBe(true);
    expect(first?.run.status).toBe("blocked");

    const second = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "scheduled",
        composeDeps: makeComposeDeps()
      })
    );
    // Idempotent skip: the SAME blocked run is returned, not a fresh one.
    expect(second?.created).toBe(false);
    expect(second?.run.id).toBe(first?.run.id);

    // Exactly one scheduled run row exists for the definition for the day.
    const runs = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listRuns(scopedDb, definition.id)
    );
    const scheduledRuns = runs.filter((r) => r.run_kind === "scheduled");
    expect(scheduledRuns).toHaveLength(1);
    expect(scheduledRuns[0]?.status).toBe("blocked");
  });

  it("fails loudly when the Briefings repository is called without withDataContext", async () => {
    await expect(repository.listDefinitions({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
    await expect(
      repository.getOwnedDefinitionById({} as never, briefingIds.userBPrivate)
    ).rejects.toThrow("Repository access requires withDataContext");
    await expect(
      repository.generateRun({} as never, briefingIds.userBPrivate, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps()
      })
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});
