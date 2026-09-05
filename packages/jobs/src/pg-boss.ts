import {
  PgBoss,
  type ConstructorOptions,
  type Job,
  type Queue,
  type SendOptions,
  type WorkOptions
} from "pg-boss";
import { sql, type Kysely } from "kysely";

export type { Job, PgBoss };

import { assertUuid } from "@moss/db";
import type { AccessContext, DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";

export const PGBOSS_SCHEMA = "pgboss";
export const RLS_PROBE_QUEUE = "rls-probe";
export const UPGRADE_CHECK_QUEUE = "system.upgrade-check";
export const UPGRADE_NOTIFY_QUEUE = "system.upgrade-notify";
export const PLATFORM_MODULE_CONTROL_QUEUE = "platform.module-control";
export const MODULE_BUILD_QUEUE = "module-build";
export const MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS = 60;

export interface ActorScopedJobPayload {
  readonly actorUserId: string;
}

export interface RlsProbeJobPayload extends ActorScopedJobPayload {
  readonly targetItemId: string;
}

export interface QueueDefinition {
  readonly name: string;
  readonly options?: Omit<Queue, "name">;
}

type UpdatableQueueOptions = Exclude<Parameters<PgBoss["updateQueue"]>[1], undefined>;

export const FOUNDATION_QUEUES: readonly QueueDefinition[] = [
  {
    name: RLS_PROBE_QUEUE,
    options: {
      retryLimit: 0,
      deleteAfterSeconds: 60,
      retentionSeconds: 60
    }
  },
  {
    name: UPGRADE_CHECK_QUEUE,
    options: {
      retryLimit: 3,
      deleteAfterSeconds: 86400,
      retentionSeconds: 86400
    }
  },
  {
    name: UPGRADE_NOTIFY_QUEUE,
    options: {
      retryLimit: 3,
      deleteAfterSeconds: 86400,
      retentionSeconds: 86400
    }
  },
  {
    name: PLATFORM_MODULE_CONTROL_QUEUE,
    options: {
      retryLimit: 3,
      deleteAfterSeconds: 3600,
      retentionSeconds: 3600
    }
  },
  {
    name: MODULE_BUILD_QUEUE,
    options: {
      retryLimit: 3,
      deleteAfterSeconds: 3600,
      retentionSeconds: 3600,
      heartbeatSeconds: MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS
    }
  }
];

/**
 * The complete set of allowed metadata keys for all pg-boss payloads in this codebase.
 * Enumerated from all live boss.send() / sendJob() call sites.
 * Hard invariant: no key that carries content, prompts, secrets, or tokens may appear here.
 */
export const ALLOWED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "actorUserId",
  "taskId",
  "requestedStatus",
  "definitionId",
  "briefingRunId",
  "runKind",
  "briefingType",
  "threadId",
  "messageId",
  "userMessageId",
  "assistantMessageId",
  "targetItemId",
  "kind",
  "jobId",
  "resourceId",
  "connectorAccountId",
  "idempotencyKey",
  "sourcePath",
  "filePath",
  "localDate",
  "chunkOffset",
  "fileHash",
  "op",
  "source",
  "goalId",
  "goalUpdatedAt",
  "reason",
  "sourceRef",
  "sourceVersion",
  "sourceKind",
  "sourceRefHash",
  "version",
  "personId",
  "personUpdatedAt",
  "phase",
  "cursor",
  "chunkIndex",
  "startedAt",
  "calendarSeenSince",
  "calendarUpserted",
  "emailDeferred",
  "calendarReconciled",
  "emailUpserted",
  "emailFailures",
  "escalations",
  "errors",
  "buildId",
  "step",
  "workflowRunId",
  "stepRunId",
  "trigger"
]);

export function assertMetadataOnlyPayload(payload: unknown): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Job payload must be an object containing metadata keys only");
  }
  const forbidden = Object.keys(payload).filter((k) => !ALLOWED_PAYLOAD_KEYS.has(k));
  if (forbidden.length > 0) {
    throw new Error(
      `Job payload contains non-metadata keys: ${forbidden.join(", ")}. ` +
        `Payloads must contain only: ${[...ALLOWED_PAYLOAD_KEYS].join(", ")}`
    );
  }
}

/**
 * Send-side wrapper that enforces the metadata-only payload invariant before
 * delegating to boss.send(). Use this everywhere instead of raw boss.send().
 */
export async function sendJob<T extends ActorScopedJobPayload>(
  boss: PgBoss,
  queue: string,
  payload: T,
  options?: SendOptions
): Promise<string | null> {
  assertMetadataOnlyPayload(payload);
  return options === undefined ? boss.send(queue, payload) : boss.send(queue, payload, options);
}

/** Return whether an actor has a created, retrying, or active job in the named queue. */
export async function hasInFlightJob(
  rootDb: Kysely<MossDatabase>,
  queueName: string,
  actorUserId: string
): Promise<boolean> {
  const result = await sql<{ in_flight: boolean }>`
    select exists (
      select 1
      from pgboss.job
      where name = ${queueName}
        and state in ('created', 'retry', 'active')
        and data->>'actorUserId' = ${actorUserId}
    ) as in_flight
  `.execute(rootDb);
  return result.rows[0]?.in_flight ?? false;
}

/**
 * Return whether a job in the named queue with the given singleton key was created within the
 * last `singletonSeconds` seconds. Time-bounded on `created_on`, scoped by the real
 * `singleton_key` column (backing unique index `job_i4`) rather than reconstructing the composite
 * key from `data->>` — independent of which `singleton_on` epoch bucket the row landed in (#1547).
 */
export async function hasRecentJob(
  db: Kysely<MossDatabase>,
  queueName: string,
  singletonKey: string,
  singletonSeconds: number
): Promise<boolean> {
  const result = await sql<{ recent: boolean }>`
    select exists (
      select 1
      from pgboss.job
      where name = ${queueName}
        and singleton_key = ${singletonKey}
        and state <> 'cancelled'
        and created_on >= now() - (${singletonSeconds} || ' seconds')::interval
    ) as recent
  `.execute(db);
  return result.rows[0]?.recent ?? false;
}

export interface PgBossClientHooks {
  /**
   * Invoked for pg-boss internal `error` events. Defaults to structured stderr logging.
   *
   * NEVER rethrow from here (#158): the `error` event fires on pg-boss's own maintenance
   * connection, and a throw inside the EventEmitter listener escalates to an
   * `uncaughtException` that crashes the entire host process on a transient DB blip. A
   * long-lived process (the API HTTP server) must survive a momentary boss-connection error,
   * so the default handler logs and continues.
   */
  readonly onError?: (error: Error) => void;
}

function defaultOnPgBossError(error: Error): void {
  // Single-line structured JSON for log scrapers. We deliberately serialise only name+message,
  // never the raw error object — some driver errors carry the connection string.
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event: "pgboss.internal_error",
      name: error.name,
      message: error.message
    })}\n`
  );
}

/**
 * Resolve the full pg-boss ConstructorOptions for a client. Defaults keep every
 * background engine OFF (schedule/supervise/migrate/createSchema = false) so that
 * cron is opt-in per process — the one-cron-owner invariant (F14): only the worker
 * passes `{ schedule: true }`; the API leaves the default, so exactly one process
 * runs the cron engine. Pure + exported so call-site options are unit-testable
 * without constructing a real PgBoss / connecting to Postgres.
 */
export function resolvePgBossConstructorOptions(
  connectionString: string,
  overrides: Partial<ConstructorOptions> = {}
): ConstructorOptions {
  return {
    connectionString,
    schema: PGBOSS_SCHEMA,
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
    ...overrides
  };
}

export function createPgBossClient(
  connectionString: string,
  overrides: Partial<ConstructorOptions> = {},
  hooks: PgBossClientHooks = {}
): PgBoss {
  const boss = new PgBoss(resolvePgBossConstructorOptions(connectionString, overrides));

  const onError = hooks.onError ?? defaultOnPgBossError;
  boss.on("error", (error: unknown) => {
    onError(error instanceof Error ? error : new Error(String(error)));
  });

  return boss;
}

function toUpdatableQueueOptions(options?: Omit<Queue, "name">): UpdatableQueueOptions | null {
  const { policy: _policy, partition: _partition, ...updatable } = options ?? {};
  return Object.keys(updatable).length > 0 ? updatable : null;
}

export async function migratePgBoss(
  connectionString: string,
  queues: readonly QueueDefinition[] = FOUNDATION_QUEUES,
  overrides: Partial<ConstructorOptions> = {}
): Promise<void> {
  const boss = createPgBossClient(connectionString, {
    migrate: true,
    createSchema: true,
    ...overrides
  });

  await boss.start();
  try {
    for (const queue of queues) {
      const existing = await boss.getQueue(queue.name);
      const desiredPolicy = queue.options?.policy ?? "standard";
      const currentPolicy = existing?.policy ?? "standard";

      if (existing && currentPolicy !== desiredPolicy) {
        // A queue's policy cannot be changed in place: pg-boss's UpdateQueueOptions
        // omits `policy`, and the singletonKey dedup index is policy-filtered
        // (job_iN ... WHERE policy = '<policy>'), so a job only dedupes if its row's
        // policy column matches. The only way to flip policy is to drop and recreate
        // the queue. Safe in this pre-prod project where queued jobs are ephemeral;
        // logged so the one-time drop of any in-flight jobs is visible.
        process.stderr.write(
          `${JSON.stringify({
            level: "warn",
            event: "pgboss.queue_policy_recreate",
            queue: queue.name,
            from: currentPolicy,
            to: desiredPolicy
          })}\n`
        );
        await boss.deleteQueue(queue.name);
        await boss.createQueue(queue.name, queue.options);
      } else if (existing) {
        // pg-boss v12's updateQueue throws if the options object carries `policy`
        // or `partition` (manager.js rejects both keys outright — it does not compare
        // values, so even an unchanged policy errors) and asserts a non-empty object.
        // Strip those non-updatable keys so re-running `pnpm db:migrate` against an
        // already-created policy-bearing queue (e.g. briefings `exclusive`) stays
        // idempotent — the migrate contract requires exit 0 on every run, not just the
        // first. The policy-change case is handled above by drop+recreate.
        const updatable = toUpdatableQueueOptions(queue.options);
        if (updatable) {
          await boss.updateQueue(queue.name, updatable);
        }
      } else {
        // Apply updatable options after create so two migrators racing the same fresh queue still
        // converge on identical options: whichever createQueue wins, both then updateQueue. The
        // create-vs-update split is required because updateQueue rejects policy/partition keys.
        await boss.createQueue(queue.name, queue.options);
        const updatable = toUpdatableQueueOptions(queue.options);
        if (updatable) {
          await boss.updateQueue(queue.name, updatable);
        }
      }
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function registerDataContextWorker<TPayload extends ActorScopedJobPayload, TResult>(
  boss: PgBoss,
  queueName: string,
  dataContext: DataContextRunner,
  handler: (job: Job<TPayload>, scopedDb: DataContextDb) => Promise<TResult>,
  options: WorkOptions = { pollingIntervalSeconds: 2 }
): Promise<string> {
  return boss.work<TPayload, TResult>(queueName, options, async ([job]) => {
    if (!job) {
      throw new Error(`pg-boss invoked ${queueName} without a job`);
    }

    return dataContext.withDataContext(toAccessContext(job), (scopedDb) => handler(job, scopedDb));
  });
}

export function toAccessContext(job: Job<ActorScopedJobPayload>): AccessContext {
  if (!job.data.actorUserId) {
    throw new Error(`Job ${job.id} is missing actorUserId`);
  }
  // The actor id becomes the RLS principal via withDataContext → set_config. Shape-check it at
  // the job boundary so a malformed payload fails with a job-scoped error rather than a 22P02
  // surfacing deep inside a handler query (#158).
  assertUuid(job.data.actorUserId, `Job ${job.id} actorUserId`);

  return {
    actorUserId: job.data.actorUserId,
    requestId: `pgboss:${job.id}`
  };
}
