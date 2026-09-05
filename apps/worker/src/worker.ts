import type { ConstructorOptions, PgBoss } from "pg-boss";
import { pino, type Logger as PinoLogger } from "pino";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  getMossDatabaseUrls,
  resolveMossEnv,
  type AccessContext
} from "@moss/db";
import { RlsProbeRepository } from "@moss/db/probes";
import {
  RLS_PROBE_QUEUE,
  UPGRADE_CHECK_QUEUE,
  createPgBossClient,
  registerDataContextWorker,
  reconcileUpgradeCheckSchedule,
  handleUpgradeCheckJob,
  registerUpgradeNotifyWorker,
  assertModuleControlPayload,
  PLATFORM_MODULE_CONTROL_QUEUE,
  MODULE_BUILD_QUEUE,
  MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS,
  createModuleBuildWorker,
  sendJob,
  type ExternalModuleJobPayload,
  type ModuleControlPayload,
  type ModuleBuildPayload,
  type RlsProbeJobPayload
} from "@moss/jobs";
import {
  aggregateFocusSignals,
  createActiveModulesResolver,
  createNotificationPreferencePort,
  focusSignalProvidersFor,
  getAllQueueDefinitions,
  getBuiltInModuleManifests,
  registerBuiltInModuleWorkers,
  resolveActorTimezone
} from "@moss/module-registry";
import {
  ExternalModuleJobReconciler,
  ExternalModuleWorkerRuntime,
  createExternalModuleDiscoveryHolder,
  resolveModulesDir
} from "@moss/module-registry/node";
import { AiRepository, runModuleBuildStep, createAiSecretCipher } from "@moss/ai";
import { ChatAttachmentsService } from "@moss/chat";
import { NotificationsRepository, type CreateNotificationInput } from "@moss/notifications";
import {
  createModuleCredentialSecretCipher,
  getModuleBuild,
  touchModuleBuildActivity,
  updateModuleBuildStatus
} from "@moss/settings";
import { getVaultBaseDir, VaultContextRunner } from "@moss/vault";

import { createModuleWorkerAiBridge } from "./external-module-ai-bridge.js";
import { buildDiscoveryLookup } from "./external-module-discovery.js";
import { createExternalBriefingInvoker } from "./external-module-invoke.js";
import { createExternalModuleJobHandler } from "./external-module-job-handler.js";
import { createIsModuleEnabled } from "./worker-module-gate.js";
import { createModuleBuildSourceGenerator } from "./module-build-source.js";
import {
  createRunModuleBuildStepForJob,
  ModuleBuildSafeError
} from "./module-build-step-runner.js";
import { WORKSHOP_MODULE_ID } from "@moss/workshop";

// ---------------------------------------------------------------------------
// Bounded graceful-shutdown timeout (ms). On SIGINT/SIGTERM the worker waits
// up to this long for in-flight jobs to drain before destroying the DB pool.
// The crash path keeps its own 2s race — this value is for the clean path.
// ---------------------------------------------------------------------------
const GRACEFUL_STOP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// One-background-engine-owner invariant (F14, #650)
//
// pg-boss's per-definition cron engine and active-job supervisor must run in
// EXACTLY ONE process. The worker is that process: it constructs its boss with
// `{ schedule: true, supervise: true }`. The API process (apps/api/src/server.ts)
// passes no override, so it keeps the shared `createPgBossClient` defaults and
// never starts a second background engine. Exported so this invariant is
// unit-testable at the worker call site (tests/unit/worker-schedule-mode.test.ts).
// ---------------------------------------------------------------------------
export const WORKER_BOSS_OPTIONS: Partial<ConstructorOptions> = {
  schedule: true,
  supervise: true
};

/**
 * Emit a single structured startup line making the cron owner observable in logs.
 * Exported so the assertion ("who owns cron") does not depend on spawning the
 * worker binary.
 */
export function logScheduleMode(): void {
  console.log(JSON.stringify({ event: "pgboss.schedule_mode", schedule: true }));
}

export function workshopExecutionUnavailable(): never {
  throw new ModuleBuildSafeError(
    "Workshop execution is unavailable until its isolated runtime is verified."
  );
}

export interface WorkerHandle {
  readonly boss: PgBoss;
  shutdown(): Promise<void>;
}

export function resolveExternalWorkerConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly modulesDir: string;
} {
  return { modulesDir: resolveModulesDir(env) };
}

/**
 * The notification posted when a module build reaches an end state (#1949 Task 1.4).
 * `eventKey` is per build+outcome so a pg-boss retry that fails again updates the
 * same notification row instead of creating a duplicate.
 */
export function buildModuleBuildNotification(
  buildId: string,
  outcome: "finished" | "failed"
): CreateNotificationInput {
  return {
    moduleId: WORKSHOP_MODULE_ID,
    title: outcome === "finished" ? "Your module is ready for a look" : "Your module build failed",
    href: "/workshop",
    eventKey: `module-build:${buildId}:${outcome}`
  };
}

/**
 * Build and wire the worker.
 *
 * Extracted from the module-level bootstrap so the lifecycle (boss.start →
 * queue-existence guard → worker registration → boss.stop → db.destroy) can
 * be unit-tested without spawning the real binary entry point.
 *
 * Exported for tests; the module-level IIFE below is the production entry point
 * and keeps the same observable behaviour.
 */
export async function buildWorker(deps?: { connectionString?: string }): Promise<WorkerHandle> {
  const urls = getMossDatabaseUrls();
  const connectionString = deps?.connectionString ?? urls.worker;

  // Structured logger for worker-path module diagnostics (#413). Threaded into
  // each module's worker registration so no `console.*` lands in production
  // worker logs; module-tagged children are created by the registry. Level honors
  // LOG_LEVEL (pino default is "info"). Suppressed in unit tests via LOG_LEVEL.
  const workerLogger: PinoLogger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { process: "worker" }
  });

  const workerDb = createDatabase({
    connectionString,
    maxConnections: Number(resolveMossEnv(process.env, "JARVIS_WORKER_DB_POOL_SIZE") ?? 4)
  });
  const dataContext = new DataContextRunner(workerDb);
  const repository = new RlsProbeRepository();
  // The worker is the SOLE pg-boss cron + supervisor owner (F14, #650): enable
  // schedule and supervise here and ONLY here, so scheduled jobs fire once and
  // expired active jobs are reaped by one long-running process. The API process
  // keeps the shared `createPgBossClient` defaults. WORKER_BOSS_OPTIONS +
  // logScheduleMode make the ownership invariant unit-testable + observable.
  const boss = createPgBossClient(connectionString, WORKER_BOSS_OPTIONS);
  const resolveActiveModules = createActiveModulesResolver({
    dataContext,
    manifests: () => getBuiltInModuleManifests()
  });
  logScheduleMode();

  await boss.start();

  // -------------------------------------------------------------------------
  // Startup queue-existence guard (#165 MED)
  //
  // pg-boss queues are created by `pnpm db:migrate` (migratePgBoss). If the
  // schema is ahead of the worker binary (e.g. fresh database without a
  // migration run) some queues may be absent, causing jobs to pile up
  // silently. Fail fast so the operator can run `pnpm db:migrate` first.
  // -------------------------------------------------------------------------
  const expectedQueues = getAllQueueDefinitions().map((q) => q.name);
  const missingQueues: string[] = [];
  for (const queueName of expectedQueues) {
    const existing = await boss.getQueue(queueName);
    if (!existing) {
      missingQueues.push(queueName);
    }
  }
  if (missingQueues.length > 0) {
    await boss.stop({ graceful: false });
    await workerDb.destroy();
    throw new Error(
      `Worker startup failed — the following pg-boss queues do not exist: ` +
        `${missingQueues.join(", ")}. ` +
        `Run \`pnpm db:migrate\` to create them before starting the worker.`
    );
  }

  const aiRepository = new AiRepository();
  const moduleBuildCipher = createAiSecretCipher();
  const moduleBuildNotifications = new NotificationsRepository(
    undefined,
    createNotificationPreferencePort()
  );
  const runModuleBuildStepForJob = createRunModuleBuildStepForJob({
    dataContext,
    getModuleBuild,
    touchModuleBuildActivity,
    updateModuleBuildStatus,
    prepareRunStepDeps: async (scopedDb, access) => ({
      assertExecutionAvailable: workshopExecutionUnavailable,
      generateSource: createModuleBuildSourceGenerator(scopedDb, access.actorUserId, {
        repository: aiRepository,
        cipher: moduleBuildCipher,
        logger: workerLogger
      }),
      acceptSource: workshopExecutionUnavailable
    }),
    runStep: runModuleBuildStep,
    notifyFinished: (scopedDb, buildId) =>
      moduleBuildNotifications.create(scopedDb, buildModuleBuildNotification(buildId, "finished")),
    notifyFailed: (scopedDb, buildId) =>
      moduleBuildNotifications.create(scopedDb, buildModuleBuildNotification(buildId, "failed"))
  });
  await boss.work<ModuleBuildPayload>(
    MODULE_BUILD_QUEUE,
    { heartbeatRefreshSeconds: MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS / 3 },
    createModuleBuildWorker({ boss, sendJob, runStep: runModuleBuildStepForJob })
  );

  await registerDataContextWorker<RlsProbeJobPayload, { targetItemVisible: boolean }>(
    boss,
    RLS_PROBE_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      const item = await repository.getById(scopedDb, job.data.targetItemId);

      return {
        targetItemVisible: item !== undefined
      };
    }
  );

  await reconcileUpgradeCheckSchedule(boss);
  await boss.work(UPGRADE_CHECK_QUEUE, async () => {
    await handleUpgradeCheckJob(workerDb, boss);
  });
  await registerUpgradeNotifyWorker(boss, dataContext, {
    logger: workerLogger,
    repository: new NotificationsRepository(undefined, createNotificationPreferencePort())
  });

  // #996/#860: external-module job reconciliation is always-on now (the
  // JARVIS_ENABLE_EXTERNAL_MODULES gate was removed) — resolveExternalWorkerConfig
  // always resolves a modulesDir, so this block runs unconditionally.
  //
  // Moved above registerBuiltInModuleWorkers (#1282 Task 2): the briefings module
  // needs externalBriefingManifests + invokeExternalBriefing at registration time,
  // and both are built from this same discovery/runtime/cipher setup. Building it
  // once here and threading it down avoids a second discovery scan.
  const externalConfig = resolveExternalWorkerConfig();
  const reservedQueueNames = new Set(getAllQueueDefinitions().map((queue) => queue.name));
  const externalModuleHolder = createExternalModuleDiscoveryHolder({
    modulesDir: externalConfig.modulesDir,
    reservedQueueNames
  });
  const externalRuntime = new ExternalModuleWorkerRuntime({ logger: workerLogger });
  const runtime = externalRuntime;
  const cipher = createModuleCredentialSecretCipher();
  // ctx.ai for queued module jobs (JS-07 Step 0, spec D6): one repository and
  // one bridge at composition time — the bridge's AiSecretCipher is a separate
  // key domain (JARVIS_AI_SECRET_KEY) from the ModuleCredentialCipher above.
  // Only the module-job registration below receives it; every other handler
  // path stays without an ai dep and fails closed in the rpc host.
  const moduleAiBridge = createModuleWorkerAiBridge({
    aiRepository: new AiRepository(),
    logger: workerLogger as unknown as FastifyBaseLogger
  });
  // ctx.notify (Task 2b, #1283): same construction as apps/api/src/external-module-tools.ts
  // — no quiet-hours port, parity with registerUpgradeNotifyWorker's own repository above.
  // A separate instance from that one: NotificationsRepository holds no per-call state, so
  // this only avoids implying the module-notify and upgrade-notify paths share a lifecycle.
  const moduleNotifications = new NotificationsRepository(
    undefined,
    createNotificationPreferencePort()
  );
  const postModuleNotification = async (
    access: AccessContext,
    notifyInput: CreateNotificationInput
  ): Promise<void> => {
    await dataContext.withDataContext(access, (scopedDb) =>
      moduleNotifications.create(scopedDb, notifyInput)
    );
  };
  // ctx.attachments.readText (#109 parity fix): identical construction to
  // apps/api/src/external-module-tools.ts's `attachments` + readAttachmentText closure.
  // The two composition roots drifted because this dependency was wired into the
  // synchronous tool-dispatch path when it was added (#932-era) without a matching pass
  // through this file — worker-rpc-host.ts's `readAttachmentText` is optional and its
  // `attachments.readText` RPC method returns null silently when absent, so a queued job
  // (or a briefing) reading a job-search résumé attachment saw the identical "missing
  // attachment" outcome as a genuinely-missing one, with no way to tell them apart.
  const attachments = new ChatAttachmentsService(new VaultContextRunner(getVaultBaseDir()));
  const readModuleAttachmentText = async (access: AccessContext, attachmentId: string) => {
    const content = await attachments.readContent(access, attachmentId);
    return content.kind === "text"
      ? {
          fileName: content.meta.fileName,
          mimeType: content.meta.mimeType,
          text: content.text
        }
      : null;
  };
  const getDiscoveryById = buildDiscoveryLookup(externalModuleHolder);
  const listDiscoveredModuleIds = () =>
    externalModuleHolder.getDiscoveries().map((module) => module.id);
  const listActiveUserIds = async (moduleId: string): Promise<readonly string[]> =>
    (
      await sql<{
        user_id: string;
      }>`SELECT user_id FROM app.list_active_external_module_users(${moduleId})`.execute(workerDb)
    ).rows.map((row) => row.user_id);

  // #1282 Task 2: same discovery/runtime/cipher this file already built above for the job
  // queue path, adapted to the narrower shape the briefing composer calls (see
  // external-module-invoke.ts for the shared trust gate both paths run through).
  //
  // #1306 Task 22: deliberately no `createFetch` here. A briefing contribution renders
  // from stored records (see external-modules/job-search/src/worker/handlers/briefing.ts) —
  // there is no fetch on this path for the e2e/UAT fixture override to redirect. If a
  // briefing handler ever does gain a fetch, this is the call site to pass
  // resolveE2eFetchOverride() into (see external-module-job-handler.ts for the queue-path
  // precedent) — don't let the omission read as an oversight.
  const invokeExternalBriefing = createExternalBriefingInvoker({
    workerDb,
    getDiscoveryById,
    listDiscoveredModuleIds,
    dataContext,
    cipher,
    runtime,
    listActiveUserIds,
    ai: moduleAiBridge,
    postNotification: postModuleNotification,
    readAttachmentText: readModuleAttachmentText
  });

  await registerBuiltInModuleWorkers(boss, {
    rootDb: workerDb,
    dataContext,
    focusSignals: async (ctx) => {
      const providers = focusSignalProvidersFor(await resolveActiveModules(ctx.actorUserId));
      if (providers.length === 0) return [];
      return aggregateFocusSignals(
        providers,
        (work) =>
          dataContext.withDataContext(
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            (scopedDb) => work(scopedDb)
          ),
        ctx,
        {
          onProviderError: (moduleId, errorName) =>
            workerLogger.warn({ moduleId, errorName }, "focus-signal provider failed (soft)")
        }
      );
    },
    // Pino's Logger is structurally what FastifyBaseLogger wraps at runtime
    // (Fastify uses pino internally). The cast bridges the nominal type gap.
    logger: workerLogger as unknown as FastifyBaseLogger,
    externalBriefingManifests: externalModuleHolder
      .getDiscoveries()
      .map((module) => module.manifest),
    invokeExternalBriefing
  });

  const externalReconciler = new ExternalModuleJobReconciler({
    boss,
    discoveries: externalModuleHolder.getDiscoveries,
    reservedQueueNames,
    isModuleEnabled: createIsModuleEnabled({ db: workerDb, getDiscoveryById }),
    listActiveUserIds,
    registerWorker: async (module, queue) => {
      // Handler body extracted to external-module-job-handler.ts (JS-07
      // Step 0) so the queue path is integration-testable with real deps.
      await registerDataContextWorker<ExternalModuleJobPayload, unknown>(
        boss,
        queue.name,
        dataContext,
        createExternalModuleJobHandler({
          module,
          queue,
          runtime,
          workerDb,
          dataContext,
          cipher,
          getDiscoveryById,
          listDiscoveredModuleIds,
          listActiveUserIds,
          ai: moduleAiBridge,
          postNotification: postModuleNotification,
          readAttachmentText: readModuleAttachmentText,
          logger: workerLogger,
          // #1789: so a module running as a background job files things under the user's
          // calendar day, not the server's. The request id names this read specifically —
          // it is not the job's own work, it is the host answering "where is this user".
          resolveLocalTimezone: (actorUserId) =>
            resolveActorTimezone(dataContext, {
              actorUserId,
              requestId: "module-job:resolve-locale-tz"
            })
        })
      );
    },
    logger: workerLogger
  });
  const reconciler = externalReconciler;
  await boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, async ([job]) => {
    if (!job) throw new Error("module control worker received no job");
    assertModuleControlPayload(job.data);
    if (job.data.action === "rescan") {
      await externalModuleHolder.rescan();
      await reconciler.reconcileAll();
      return;
    }
    await reconciler.reconcileModule(job.data.moduleId);
  });
  await externalReconciler.reconcileAll();

  // -------------------------------------------------------------------------
  // Graceful-shutdown (#165 MED)
  //
  // boss.stop({ graceful: true }) asks pg-boss to drain in-flight jobs before
  // closing its own connections. We race against a bounded timeout so a hung
  // drain still exits cleanly. workerDb.destroy() is always called AFTER
  // boss.stop() resolves — workerDb is the Kysely pool that job *handlers* run
  // against, so it must outlive the drain (pg-boss owns a separate connection).
  // -------------------------------------------------------------------------
  async function shutdown(): Promise<void> {
    await externalReconciler?.close();
    await externalRuntime?.close();
    await Promise.race([
      boss.stop({ graceful: true }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, GRACEFUL_STOP_TIMEOUT_MS);
      })
    ]);
    await workerDb.destroy();
  }

  return { boss, shutdown };
}

// ---------------------------------------------------------------------------
// Production entry point: build, wire signal handlers, run.
//
// Guarded by `import.meta.url === file://${process.argv[1]}` so importing this
// module in a unit test (to assert WORKER_BOSS_OPTIONS / logScheduleMode — the
// one-cron-owner invariant) does NOT connect to Postgres or register a worker.
// Mirrors apps/api/src/server.ts's bootstrap guard.
// ---------------------------------------------------------------------------
/**
 * Crash-handler factory for the worker entrypoint (spec §1140-E, #1527). Both
 * `unhandledRejection` and `uncaughtException` share the closure-local
 * `crashing` latch below: the first crash notification logs, races a bounded
 * drain, and exits; any later notification in the same window is a no-op, so
 * a second error can never re-log, re-drain, or re-exit.
 *
 * Exported (and parameterized with log/timeout/exit) so it is unit-testable
 * without spawning the real binary or racing a second real crash.
 *
 * LOW (#165): document the intentional escalation path — unhandledRejection
 * and uncaughtException both funnel here, which logs, attempts a bounded
 * drain (2s race by default), then exits with code 1.
 *
 * MED (#158): pg-boss internal `error` events are NOT routed through this
 * handler — they are logged structured (defaultOnPgBossError) without
 * escalation, so a transient boss-connection blip cannot crash the worker
 * mid-drain. Genuine fatal failures still surface through
 * unhandledRejection / uncaughtException.
 */
export function createCrashHandler(
  handle: { shutdown(): Promise<void> },
  opts: { timeoutMs?: number; exit?: (code: number) => never; log?: (line: string) => void } = {}
): (label: string, err: unknown) => void {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.error(line));
  let crashing = false;
  return (label: string, err: unknown): void => {
    if (crashing) return;
    crashing = true;
    // LOW (#165): log err.message for Error values instead of String(err), which
    // would stringify a non-Error object (e.g. a config/pool object) and could
    // surface a connection string. Non-Error rejection reasons collapse to
    // "unknown" — blunt, but never leaks.
    const message = err instanceof Error ? err.message : "unknown";
    log(JSON.stringify({ level: "fatal", label, err: message, msg: "Process crash — exiting" }));
    const drain = Promise.race([
      handle.shutdown(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
    void drain.then(() => {
      exit(1);
    });
  };
}

async function bootstrap(): Promise<void> {
  const handle = await buildWorker();

  console.log(`Jarv1s worker listening on ${RLS_PROBE_QUEUE} and built-in module queues`);

  const handleCrash = createCrashHandler(handle);

  process.once("SIGINT", () => {
    void handle.shutdown().then(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void handle.shutdown().then(() => process.exit(0));
  });

  process.on("unhandledRejection", (reason) => {
    handleCrash("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err: Error) => {
    handleCrash("uncaughtException", err);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await bootstrap();
}
