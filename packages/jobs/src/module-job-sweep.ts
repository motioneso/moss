import type { PgBoss } from "pg-boss";
import { CompiledQuery, sql, type Kysely, type Transaction } from "kysely";

import type { MossDatabase } from "@moss/db";

const MODULE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Queue prefixes the platform owns. A module id equal to one of these never sweeps.
const RESERVED_MODULE_IDS: readonly string[] = ["system", "platform"];

export interface ModuleJobSweepLogger {
  info(data: Record<string, unknown>, message?: string): void;
  warn(data: Record<string, unknown>, message?: string): void;
}

export interface ModuleJobSweepResult {
  readonly cancelled: number;
  /** Rows left running. The caller schedules a second pass for them. */
  readonly leftActive: number;
}

/** Advisory lock key shared by module job enqueue and the lifecycle sweep, per module and actor. */
export function moduleEnqueueLockKey(moduleId: string, actorUserId: string): string {
  return `module-enqueue:${moduleId}:${actorUserId}`;
}

function moduleEnqueueBarrierKey(moduleId: string): string {
  return `module-enqueue:${moduleId}`;
}

/**
 * Run `work` in a transaction holding the per-actor enqueue lock, plus the module barrier in
 * shared mode. An enqueue repeats its module-live check inside this lock before sending, so it
 * cannot interleave with a sweep.
 */
export async function withModuleEnqueueLock<T>(
  rootDb: Kysely<MossDatabase>,
  moduleId: string,
  actorUserId: string,
  work: (trx: Transaction<MossDatabase>) => Promise<T>
): Promise<T> {
  return rootDb.transaction().execute(async (trx) => {
    const barrier = moduleEnqueueBarrierKey(moduleId);
    const key = moduleEnqueueLockKey(moduleId, actorUserId);
    await sql`select pg_advisory_xact_lock_shared(hashtextextended(${barrier}, 0))`.execute(trx);
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    return work(trx);
  });
}

/**
 * Waits until every enqueue already holding the module barrier has finished. The sweep calls
 * this before it lists actors, so an enqueue that passed its live check before the disable is
 * visible to the sweep, and any later one sees the disabled status and refuses.
 */
async function awaitInFlightModuleEnqueues(
  rootDb: Kysely<MossDatabase>,
  moduleId: string
): Promise<void> {
  await rootDb.transaction().execute(async (trx) => {
    const barrier = moduleEnqueueBarrierKey(moduleId);
    await sql`select pg_advisory_xact_lock(hashtextextended(${barrier}, 0))`.execute(trx);
  });
}

function assertSweepableModuleId(moduleId: string): void {
  if (!MODULE_ID_PATTERN.test(moduleId) || RESERVED_MODULE_IDS.includes(moduleId)) {
    throw new Error("Module job sweep refused an invalid module id");
  }
}

/**
 * Queues named `<moduleId>.%`, read from the queue table so a queue the manifest dropped is
 * still covered. Dead-letter queues are failure records and are skipped.
 */
async function listSweepQueues(rootDb: Kysely<MossDatabase>, moduleId: string): Promise<string[]> {
  const prefix = `${moduleId}.`;
  const result = await sql<{ name: string }>`
    select q.name
    from pgboss.queue q
    where starts_with(q.name, ${prefix})
      and q.name not in (
        select dead_letter
        from pgboss.queue
        where dead_letter is not null
      )
    order by q.name
  `.execute(rootDb);
  return result.rows.map((row) => row.name);
}

/** Distinct actors with a waiting (created or retry) row in the module's queues. */
export async function listPendingModuleJobActors(
  rootDb: Kysely<MossDatabase>,
  moduleId: string
): Promise<string[]> {
  assertSweepableModuleId(moduleId);
  const actors = new Set<string>();
  for (const queue of await listSweepQueues(rootDb, moduleId)) {
    const result = await sql<{ actor: string | null }>`
      select distinct data->>'actorUserId' as actor
      from pgboss.job
      where name = ${queue}
        and state in ('created', 'retry')
        and data->>'moduleId' = ${moduleId}
    `.execute(rootDb);
    for (const row of result.rows) if (row.actor) actors.add(row.actor);
  }
  return [...actors].sort();
}

/**
 * Cancel the module's waiting jobs (states created and retry). Running jobs are left alone.
 * Reads queue name, id, state and the moduleId and actorUserId payload keys only. Pass
 * `actorUserId` to cancel one actor's rows and nothing else.
 */
export async function cancelPendingModuleJobs(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>,
  input: {
    readonly moduleId: string;
    readonly actorUserId?: string;
    readonly logger?: ModuleJobSweepLogger;
  }
): Promise<ModuleJobSweepResult> {
  const { moduleId, actorUserId, logger } = input;
  assertSweepableModuleId(moduleId);
  await awaitInFlightModuleEnqueues(rootDb, moduleId);
  const queues = await listSweepQueues(rootDb, moduleId);
  const actors = actorUserId ? [actorUserId] : await listPendingModuleJobActors(rootDb, moduleId);
  let cancelled = 0;
  let leftActive = 0;

  for (const queue of queues) {
    const foreign = await sql<{ count: string }>`
      select count(*) as count
      from pgboss.job
      where name = ${queue}
        and state in ('created', 'retry')
        and data->>'moduleId' is distinct from ${moduleId}
    `.execute(rootDb);
    const foreignCount = Number(foreign.rows[0]?.count ?? 0);
    if (foreignCount > 0) {
      logger?.warn(
        { moduleId, queue, foreignCount },
        "module job sweep left rows carrying another module id"
      );
    }

    for (const actor of actors) {
      cancelled += await withModuleEnqueueLock(rootDb, moduleId, actor, async (trx) => {
        // FOR UPDATE keeps a worker from claiming a chosen row before the cancel lands.
        const rows = await sql<{ id: string }>`
          select id
          from pgboss.job
          where name = ${queue}
            and state in ('created', 'retry')
            and data->>'moduleId' = ${moduleId}
            and data->>'actorUserId' = ${actor}
          for update
        `.execute(trx);
        if (rows.rows.length === 0) return 0;
        const result = await boss.cancel(
          queue,
          rows.rows.map((row) => row.id),
          {
            db: {
              executeSql: async (text: string, values?: unknown[]) => {
                const response = await trx.executeQuery(CompiledQuery.raw(text, values ?? []));
                return { rows: [...response.rows] as unknown[] };
              }
            } as never
          }
        );
        return (result as unknown as { affected: number }).affected;
      });
    }

    const active = await sql<{ count: string }>`
      select count(*) as count
      from pgboss.job
      where name = ${queue}
        and state = 'active'
        and data->>'moduleId' = ${moduleId}
        ${actorUserId ? sql`and data->>'actorUserId' = ${actorUserId}` : sql``}
    `.execute(rootDb);
    leftActive += Number(active.rows[0]?.count ?? 0);
  }

  logger?.info(
    {
      moduleId,
      queues: queues.length,
      cancelled,
      leftActive,
      ...(actorUserId ? { actorUserId } : {})
    },
    "module job sweep finished"
  );
  return { cancelled, leftActive };
}
