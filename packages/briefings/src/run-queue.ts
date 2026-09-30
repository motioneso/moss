import { randomUUID } from "node:crypto";

import type { PgBoss } from "pg-boss";

import type { BriefingDefinition } from "@moss/db";
import { sendJob } from "@moss/jobs";

import { isBriefingRunPayloadMetadataOnly, type BriefingRunPayload } from "./jobs.js";
import { BRIEFINGS_RUN_QUEUE } from "./manifest.js";
import type { RunStatusJob } from "./run-status.js";

/** Job states that still hold a run open: queued, waiting to retry, or running. */
export const IN_FLIGHT_JOB_STATES: ReadonlySet<string> = new Set(["created", "retry", "active"]);

/** Fixed idempotency key for chat re-runs, so racing chat requests collapse to one job. */
export const CHAT_RERUN_IDEMPOTENCY_KEY = "chat-rerun";

export interface BriefingRunJobRef {
  readonly jobId: string;
  /** Null for a scheduled fire, which mints its run id only when the worker picks it up. */
  readonly runId: string | null;
}

export interface ManualBriefingRunJob {
  readonly runId: string;
  readonly payload: BriefingRunPayload;
  readonly singletonKey: string;
}

/**
 * Builds the metadata-only job for one manual run of an owned definition. The singleton key is
 * namespaced by definition id so one definition's key never suppresses another's. A keyless run
 * gets a unique key (its run id) and so never collides.
 */
export function buildManualBriefingRunJob(
  actorUserId: string,
  definition: Pick<BriefingDefinition, "id" | "briefing_type">,
  idempotencyKey: string | undefined
): ManualBriefingRunJob {
  const runId = randomUUID();
  const payload: BriefingRunPayload = {
    actorUserId,
    definitionId: definition.id,
    briefingRunId: runId,
    runKind: "manual",
    briefingType: definition.briefing_type,
    idempotencyKey
  };
  const singletonKey = idempotencyKey
    ? `${definition.id}:key:${idempotencyKey}`
    : `${definition.id}:run:${runId}`;
  return { runId, payload, singletonKey };
}

/** Write-capable queue access for the chat re-run tool. Built by the host, never by a tool. */
export interface BriefingRunQueueService {
  /** The actor's queued or running job for this definition, from any source. */
  findInFlight(actorUserId: string, definitionId: string): Promise<BriefingRunJobRef | null>;
  /** Sends one job; null when the singleton key is already held by a non-terminal job. */
  send(job: ManualBriefingRunJob): Promise<string | null>;
}

/** Read-only job lookup for the chat run-status tool. */
export interface BriefingRunJobReadService {
  readJob(jobId: string): Promise<RunStatusJob | null>;
}

export function createBriefingRunQueueService(boss: PgBoss): BriefingRunQueueService {
  return {
    async findInFlight(actorUserId, definitionId) {
      const jobs = await boss.findJobs<BriefingRunPayload>(BRIEFINGS_RUN_QUEUE, {
        data: { actorUserId, definitionId }
      });
      const open = jobs.find(
        (job) =>
          IN_FLIGHT_JOB_STATES.has(job.state) &&
          isBriefingRunPayloadMetadataOnly(job.data) &&
          job.data.actorUserId === actorUserId &&
          job.data.definitionId === definitionId
      );
      if (!open) return null;
      return { jobId: open.id, runId: open.data.briefingRunId ?? null };
    },
    send(job) {
      return sendJob(boss, BRIEFINGS_RUN_QUEUE, job.payload, { singletonKey: job.singletonKey });
    }
  };
}

export function createBriefingRunJobReadService(boss: PgBoss): BriefingRunJobReadService {
  return {
    async readJob(jobId) {
      const stored = await boss.getJobById<BriefingRunPayload>(BRIEFINGS_RUN_QUEUE, jobId);
      if (!stored || !isBriefingRunPayloadMetadataOnly(stored.data)) return null;
      return {
        state: stored.state,
        data: { actorUserId: stored.data.actorUserId, briefingRunId: stored.data.briefingRunId }
      };
    }
  };
}
