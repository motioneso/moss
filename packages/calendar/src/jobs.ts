import {
  registerDataContextWorker,
  sendJob,
  toAccessContext,
  type ActorScopedJobPayload,
  type QueueDefinition,
  type PgBoss
} from "@moss/jobs";
import type { DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { CalendarRepository } from "./repository.js";
import type { ApplyExecutionRouteCallback } from "./day-plan-execute.js";

export const CALENDAR_CACHE_EVICT_QUEUE = "calendar.cache-evict-event";
export const CALENDAR_DAY_PLAN_APPLY_QUEUE = "calendar.day-plan-apply";

export const CALENDAR_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: CALENDAR_CACHE_EVICT_QUEUE,
    options: { retryLimit: 2, retryDelay: 10, deleteAfterSeconds: 300, retentionSeconds: 300 }
  },
  {
    name: CALENDAR_DAY_PLAN_APPLY_QUEUE,
    options: { retryLimit: 3, retryDelay: 30, deleteAfterSeconds: 600, retentionSeconds: 600 }
  }
];

export interface CalendarCacheEvictPayload extends ActorScopedJobPayload {
  readonly targetItemId: string;
  readonly idempotencyKey?: string;
}

// Metadata-only apply dispatch for one reserved automatic batch (R2.3-T06).
// The worker reloads the batch by these ids; anything else is rejected here
// exactly as briefing payloads are rejected by their own guard.
export interface DayPlanApplyJobPayload extends ActorScopedJobPayload {
  readonly planId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly briefingRunId: string;
}

export const DAY_PLAN_APPLY_JOB_PAYLOAD_KEYS = [
  "actorUserId",
  "planId",
  "operationId",
  "idempotencyKey",
  "briefingRunId"
] as const;

export function isDayPlanApplyPayloadMetadataOnly(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const allowedKeys = new Set<string>(DAY_PLAN_APPLY_JOB_PAYLOAD_KEYS);
  return Object.keys(payload).every((key) => allowedKeys.has(key));
}

export interface CalendarDayPlanApplyResult {
  readonly planId: string;
  readonly operationId: string;
  readonly status: "completed" | "denied";
}

export async function sendCalendarCacheEvictJob(
  boss: PgBoss,
  payload: CalendarCacheEvictPayload
): Promise<string | null> {
  return sendJob(boss, CALENDAR_CACHE_EVICT_QUEUE, payload);
}

export async function sendDayPlanApplyJob(
  boss: PgBoss,
  payload: DayPlanApplyJobPayload
): Promise<string | null> {
  return sendJob(boss, CALENDAR_DAY_PLAN_APPLY_QUEUE, payload);
}

export interface RegisterCalendarJobWorkersOptions {
  // Executes one reserved automatic batch. Injected by the composition root
  // (the executor lives in the chat module); without it the apply worker
  // fails closed before any read or write.
  readonly applyExecution?: ApplyExecutionRouteCallback;
}

export async function registerCalendarJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  options: RegisterCalendarJobWorkersOptions = {}
): Promise<string[]> {
  const repo = new CalendarRepository();
  const evictWorkId = await registerDataContextWorker<
    CalendarCacheEvictPayload,
    { evicted: boolean }
  >(boss, CALENDAR_CACHE_EVICT_QUEUE, dataContext, async (job, scopedDb) => {
    const row = await repo.getById(scopedDb, job.data.targetItemId);
    if (!row) return { evicted: false };
    await repo.deleteById(scopedDb, job.data.targetItemId);
    return { evicted: true };
  });
  // The apply worker uses boss.work directly (not registerDataContextWorker)
  // so no transaction is open around execution: the service stages its own
  // short contexts for the snapshot, provider calls and result writes, as it
  // does for the route. Holding an ambient transaction here would couple
  // provider I/O to a database transaction (invariant 5).
  const applyWorkId = await boss.work<DayPlanApplyJobPayload, CalendarDayPlanApplyResult>(
    CALENDAR_DAY_PLAN_APPLY_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error(`pg-boss invoked ${CALENDAR_DAY_PLAN_APPLY_QUEUE} without a job`);
      if (!isDayPlanApplyPayloadMetadataOnly(job.data)) {
        throw new Error(`Calendar apply job ${job.id} contains non-metadata payload fields`);
      }
      const applyExecution = options.applyExecution;
      if (!applyExecution) {
        throw new Error("day plan apply is unavailable");
      }
      const access = toAccessContext(job);
      const toolCtx: ToolContext = {
        actorUserId: access.actorUserId,
        requestId: `pgboss:${job.id}`,
        chatSessionId: ""
      };
      const report = await applyExecution({
        access,
        toolCtx,
        planId: job.data.planId,
        idempotencyKey: job.data.idempotencyKey,
        operationId: job.data.operationId
      });
      return { planId: report.planId, operationId: report.operationId, status: report.status };
    }
  );
  return [evictWorkId, applyWorkId];
}
