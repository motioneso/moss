import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { ComposeDeps, GenerateChatFn } from "@moss/briefings";
import {
  BRIEFINGS_RUN_QUEUE,
  BriefingsRepository,
  registerBriefingsJobWorkers,
  type BriefingRunResult
} from "@moss/briefings";
import type { MemoryRetriever } from "@moss/memory";
import {
  AuthSessionResolver,
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { NotificationsRepository } from "@moss/notifications";
import { PreferencesRepository } from "@moss/structured-state";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

export const briefingIds = {
  userBPrivate: "77000000-0000-4000-8000-000000000001",
  userBWorkspace: "77000000-0000-4000-8000-000000000002"
} as const;

export const sourceIds = {
  userATask: "78000000-0000-4000-8000-000000000001",
  userBPrivateTask: "78000000-0000-4000-8000-000000000002",
  userAWorkspaceTask: "78000000-0000-4000-8000-000000000003",
  userAConnector: "7a000000-0000-4000-8000-000000000001",
  userBConnector: "7a000000-0000-4000-8000-000000000002",
  userAEmail: "7b000000-0000-4000-8000-000000000001",
  userBPrivateEmail: "7b000000-0000-4000-8000-000000000002"
} as const;

// Shared wiring for the briefings integration suites. Each test FILE resets the
// foundation DB and seeds the same fixtures, then builds this harness in its own
// beforeAll — keeping the two split suites self-contained and isolated.
export interface BriefingsTestHarness {
  appDb: Kysely<MossDatabase>;
  workerDb: Kysely<MossDatabase>;
  auth: AuthSessionResolver;
  dataContext: DataContextRunner;
  repository: BriefingsRepository;
  notificationsRepository: NotificationsRepository;
  sharesRepository: SharesRepository;
  appBoss: PgBoss;
  workerBoss: PgBoss;
  server: ReturnType<typeof createApiServer>;
}

export async function setupBriefingsHarness(): Promise<BriefingsTestHarness> {
  await resetFoundationDatabase();
  await seedBriefingData();

  const appDb = createDatabase({
    connectionString: connectionStrings.app,
    maxConnections: 1
  });
  const workerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  const auth = new AuthSessionResolver(appDb);
  const dataContext = new DataContextRunner(appDb);
  const repository = new BriefingsRepository();
  const notificationsRepository = new NotificationsRepository();
  const sharesRepository = new SharesRepository();
  const appBoss = createPgBossClient(connectionStrings.app);
  const workerBoss = createPgBossClient(connectionStrings.worker);

  await appBoss.start();
  await workerBoss.start();

  const server = createApiServer({
    appDb,
    boss: appBoss,
    logger: false
  });
  await server.ready();

  return {
    appDb,
    workerDb,
    auth,
    dataContext,
    repository,
    notificationsRepository,
    sharesRepository,
    appBoss,
    workerBoss,
    server
  };
}

export async function teardownBriefingsHarness(
  harness: Partial<BriefingsTestHarness>
): Promise<void> {
  await Promise.allSettled([
    harness.server?.close(),
    harness.appBoss?.stop({ graceful: false }),
    harness.workerBoss?.stop({ graceful: false }),
    harness.appDb?.destroy(),
    harness.workerDb?.destroy()
  ]);
}

// Build synthesis deps for generateRun in these integration tests. The AI repository
// and cipher are REAL (so economy-tier model selection + in-worker credential
// decryption run against the real DB), the vault retriever is a no-op (vault grounding
// is exercised in the compose unit tests), and the adapter is injected so no real HTTP
// provider is contacted — the fake `generateChat` returns a fixed narrative by default.
export function makeComposeDeps(
  generateChat?: GenerateChatFn,
  moduleManifests: readonly MossModuleManifest[] = getBuiltInModuleManifests()
): ComposeDeps {
  const noopRetriever = {
    async retrieve() {
      return [];
    },
    async retrieveRecent() {
      return [];
    }
  } as unknown as MemoryRetriever;

  return {
    moduleManifests,
    aiRepository: new AiRepository(),
    cipher: createAiSecretCipher(),
    memoryRetriever: noopRetriever,
    sourceBehaviorPolicy: {
      manifests: moduleManifests,
      preferencesRepository: new PreferencesRepository()
    },
    createAdapter: () => ({
      generateChat: generateChat ?? (async () => ({ text: "synth narrative" }))
    })
  };
}

export function structuredRowManifest(options: {
  readonly id: string;
  readonly title: string;
  readonly category: "needs_reply" | "needs_action" | "time_sensitive_info";
  readonly cacheMessageId: string | null;
}): MossModuleManifest {
  return {
    id: options.id,
    name: options.id,
    version: "0.0.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [
      {
        name: "tasks.list",
        description: "test task reader",
        permissionId: "tasks.view",
        risk: "read",
        execute: async () => ({
          data: {
            items: [
              {
                id: `${options.id}-task`,
                title: options.title,
                description: "row explanation",
                status: "suggested",
                source: "email",
                sourceRef: "account:external-message",
                dueAt: null,
                updatedAt: "2026-07-30T12:00:00.000Z",
                suggestionMetadata: {
                  version: 1,
                  category: options.category,
                  sourceLabel: "Gmail",
                  sourceHref: "https://mail.example.test/thread",
                  cacheMessageId: options.cacheMessageId,
                  subjectSignature: "signature",
                  computedAt: "2026-07-30T12:00:00.000Z",
                  resurfaceReason: null
                }
              }
            ]
          }
        })
      }
    ]
  };
}

export async function seedBriefingData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO app.task_lists (owner_user_id, name)
        VALUES ($1, 'Personal'), ($2, 'Personal')
        ON CONFLICT DO NOTHING
      `,
      [ids.userA, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.tasks (id, owner_user_id, title, description, status, list_id)
        VALUES
          ($1, $2, 'User A briefing task', 'A task body', 'todo',
            (SELECT id FROM app.task_lists WHERE owner_user_id = $2 AND name = 'Personal' LIMIT 1)),
          ($3, $4, 'User B private briefing task', 'B task body', 'todo',
            (SELECT id FROM app.task_lists WHERE owner_user_id = $4 AND name = 'Personal' LIMIT 1)),
          ($5, $2, 'User A workspace briefing task', 'Workspace task body', 'todo',
            (SELECT id FROM app.task_lists WHERE owner_user_id = $2 AND name = 'Personal' LIMIT 1))
      `,
      [
        sourceIds.userATask,
        ids.userA,
        sourceIds.userBPrivateTask,
        ids.userB,
        sourceIds.userAWorkspaceTask
      ]
    );
    await client.query(
      `
        INSERT INTO app.connector_accounts (
          id,
          provider_id,
          owner_user_id,
          scopes,
          status,
          encrypted_secret
        )
        VALUES
          ($1, 'google-email', $2, ARRAY['gmail.readonly']::text[], 'active', '{"ciphertext":"briefing-hidden-ciphertext"}'::jsonb),
          ($3, 'google-email', $4, ARRAY['gmail.readonly']::text[], 'active', '{"ciphertext":"briefing-hidden-ciphertext"}'::jsonb)
      `,
      [sourceIds.userAConnector, ids.userA, sourceIds.userBConnector, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.email_messages (
          id,
          connector_account_id,
          owner_user_id,
          sender,
          recipients,
          subject,
          snippet,
          body_excerpt,
          received_at,
          external_id,
          external_metadata
        )
        VALUES
          ($1, $2, $3, 'sender-a@example.test', ARRAY['user-a@example.test']::text[], 'User A briefing email', 'A email snippet', 'A email excerpt', '2026-06-06T15:00:00.000Z', 'briefing-email-a', '{"source":"briefings-test"}'::jsonb),
          ($4, $5, $6, 'sender-b@example.test', ARRAY['user-b@example.test']::text[], 'User B private briefing email', 'B email snippet', 'B email excerpt', '2026-06-06T16:00:00.000Z', 'briefing-email-b', '{"source":"briefings-test"}'::jsonb)
      `,
      [
        sourceIds.userAEmail,
        sourceIds.userAConnector,
        ids.userA,
        sourceIds.userBPrivateEmail,
        sourceIds.userBConnector,
        ids.userB
      ]
    );
    await client.query(
      `
        INSERT INTO app.briefing_definitions (
          id,
          owner_user_id,
          title,
          cadence,
          selected_tool_names
        )
        VALUES
          ($1, $2, 'User B private briefing', 'manual', ARRAY['tasks.list']::text[]),
          ($3, $2, 'User B workspace briefing', 'daily', ARRAY['tasks.list']::text[])
      `,
      [briefingIds.userBPrivate, ids.userB, briefingIds.userBWorkspace]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export async function handleNextBriefingJob(
  workerBoss: PgBoss,
  composeDeps: ComposeDeps = makeComposeDeps(async () => ({ text: "synth narrative" }))
): Promise<BriefingRunResult> {
  const scopedWorkerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  const workerDataContext = new DataContextRunner(scopedWorkerDb);
  let workIds: string[] = [];

  try {
    const resultPromise = new Promise<BriefingRunResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Briefings worker"));
      }, 10_000);

      registerBriefingsJobWorkers(workerBoss, workerDataContext, {
        moduleManifests: getBuiltInModuleManifests(),
        // Inject a fake-adapter composeDeps so the worker path is deterministic and never
        // makes a real HTTP provider call (A8 injects the registry-built deps in prod).
        composeDeps,
        workOptions: { pollingIntervalSeconds: 0.5 },
        onResult: (_job, result) => {
          clearTimeout(timeout);
          resolve(result);
        }
      })
        .then((registeredWorkIds) => {
          workIds = registeredWorkIds;
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });

    return await resultPromise;
  } finally {
    await Promise.all(
      workIds.map((workId) => workerBoss.offWork(BRIEFINGS_RUN_QUEUE, { id: workId, wait: true }))
    );
    await scopedWorkerDb.destroy();
  }
}

// Same as handleNextBriefingJob, but injects a REAL NotificationsRepository bound to a
// fresh worker-role data context so the A8 notification path runs end-to-end through the
// worker INSERT grant (migration 0071) — proving the worker can actually deliver the
// "Your morning briefing is ready" notification.
export async function handleNextBriefingJobWithNotifications(
  workerBoss: PgBoss
): Promise<BriefingRunResult> {
  const scopedWorkerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  const workerDataContext = new DataContextRunner(scopedWorkerDb);
  let workIds: string[] = [];

  try {
    const resultPromise = new Promise<BriefingRunResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Briefings worker"));
      }, 10_000);

      registerBriefingsJobWorkers(workerBoss, workerDataContext, {
        moduleManifests: getBuiltInModuleManifests(),
        composeDeps: makeComposeDeps(async () => ({ text: "synth narrative" })),
        notificationsRepository: new NotificationsRepository(),
        workOptions: { pollingIntervalSeconds: 0.5 },
        onResult: (_job, result) => {
          clearTimeout(timeout);
          resolve(result);
        }
      })
        .then((registeredWorkIds) => {
          workIds = registeredWorkIds;
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });

    return await resultPromise;
  } finally {
    await Promise.all(
      workIds.map((workId) => workerBoss.offWork(BRIEFINGS_RUN_QUEUE, { id: workId, wait: true }))
    );
    await scopedWorkerDb.destroy();
  }
}

export async function countPgBossJobs(): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.migration });

  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pgboss.job"
    );

    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

export interface CapturedScheduleCall {
  readonly name: string;
  readonly cron: string;
  readonly data: Record<string, unknown>;
  readonly tz?: string;
  readonly key?: string;
}

export interface CapturedUnscheduleCall {
  readonly name: string;
  readonly key: string;
}

/**
 * Wrap the real pg-boss instance's schedule/unschedule so a route test can assert
 * the route reconciled the schedule, while STILL exercising the real boss (the calls
 * pass through to pg-boss). Returns captured calls + a restore().
 */
export function spyBossSchedule(boss: PgBoss): {
  schedule: CapturedScheduleCall[];
  unschedule: CapturedUnscheduleCall[];
  restore: () => void;
} {
  const schedule: CapturedScheduleCall[] = [];
  const unschedule: CapturedUnscheduleCall[] = [];
  const originalSchedule = boss.schedule.bind(boss);
  const originalUnschedule = boss.unschedule.bind(boss);

  boss.schedule = (async (name: string, cron: string, data?: object, options?: object) => {
    schedule.push({
      name,
      cron,
      data: (data ?? {}) as Record<string, unknown>,
      tz: (options as { tz?: string } | undefined)?.tz,
      key: (options as { key?: string } | undefined)?.key
    });
    return originalSchedule(name, cron, data as never, options as never);
  }) as typeof boss.schedule;

  boss.unschedule = (async (name: string, key: string) => {
    unschedule.push({ name, key });
    return originalUnschedule(name, key);
  }) as typeof boss.unschedule;

  return {
    schedule,
    unschedule,
    restore: () => {
      boss.schedule = originalSchedule;
      boss.unschedule = originalUnschedule;
    }
  };
}

export function userAHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ids.sessionA}`
  };
}

export function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-briefings"
  };
}

export function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-briefings"
  };
}

export function adminContext(): AccessContext {
  return {
    actorUserId: ids.adminUser,
    requestId: "request:admin-briefings"
  };
}
