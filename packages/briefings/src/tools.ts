import { assertDataContextDb, type BriefingDefinition, type DataContextDb } from "@moss/db";
import type { ToolContext, ToolInput, ToolResult, ToolServices } from "@moss/module-sdk";
import type { BriefingType } from "@moss/shared";

import { BriefingsRepository } from "./repository.js";
import { displaySummaryText } from "./run-display.js";
import {
  buildManualBriefingRunJob,
  CHAT_RERUN_IDEMPOTENCY_KEY,
  IN_FLIGHT_JOB_STATES,
  type BriefingRunJobReadService,
  type BriefingRunJobRef,
  type BriefingRunQueueService
} from "./run-queue.js";

// Only function declarations are exported here. manifest.ts imports this file and this file
// reaches manifest.ts through run-queue.ts, so exported consts would hit the cycle's TDZ.

const repository = new BriefingsRepository();

const BRIEFING_TYPES: ReadonlySet<string> = new Set<BriefingType>([
  "morning",
  "evening",
  "weekly_review"
]);
const FAILED_JOB_STATES: ReadonlySet<string> = new Set(["failed", "cancelled"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Queues one manual run of the actor's own briefing, chosen by type or by definition id. A run
 * already queued or running for that definition is returned instead of starting a second one.
 */
export async function briefingsRerunExecute(
  scopedDb: unknown,
  input: ToolInput,
  ctx: ToolContext,
  services?: ToolServices
): Promise<ToolResult> {
  assertDataContextDb(scopedDb);
  const queue = services?.briefingRunQueue as BriefingRunQueueService | undefined;
  if (!queue) {
    throw new Error("briefingRunQueue service is not available");
  }

  const definition = await resolveOwnedDefinition(scopedDb, input, ctx.actorUserId);
  if (!definition) {
    return {
      data: {
        status: "no_briefing",
        definitionId: null,
        briefingType: typeof input.briefingType === "string" ? input.briefingType : null,
        runId: null,
        jobId: null
      }
    };
  }

  const inFlight = await queue.findInFlight(ctx.actorUserId, definition.id);
  if (inFlight) return alreadyRunning(definition, inFlight);

  const job = buildManualBriefingRunJob(ctx.actorUserId, definition, CHAT_RERUN_IDEMPOTENCY_KEY);
  const jobId = await queue.send(job);
  if (!jobId) {
    // The chat singleton key is held: a racing request queued first. Report that run.
    const winner = await queue.findInFlight(ctx.actorUserId, definition.id);
    if (winner) return alreadyRunning(definition, winner);
    throw new Error("Briefing run could not be queued");
  }

  return {
    data: {
      status: "queued",
      definitionId: definition.id,
      briefingType: definition.briefing_type,
      runId: job.runId,
      jobId
    }
  };
}

/**
 * Reads one briefing run's state for the actor: ready with its text, pending, failed, or not
 * found. Another user's run and a missing run look the same.
 */
export async function briefingsGetRunStatusExecute(
  scopedDb: unknown,
  input: ToolInput,
  ctx: ToolContext,
  services?: ToolServices
): Promise<ToolResult> {
  assertDataContextDb(scopedDb);
  const runId = requireString(input.runId, "runId");
  const jobId =
    typeof input.jobId === "string" && UUID_PATTERN.test(input.jobId) ? input.jobId : null;

  const run = UUID_PATTERN.test(runId)
    ? await repository.getOwnedRunById(scopedDb, runId)
    : undefined;
  if (run) {
    const ready = run.status === "succeeded";
    return {
      data: {
        state: ready ? "ready" : "failed",
        runId: run.id,
        definitionId: run.definition_id,
        briefingType: run.briefing_type,
        createdAt: toIsoString(run.created_at),
        summaryText: ready ? displaySummaryText(run.summary_text, run.source_metadata) : null
      }
    };
  }

  const jobs = services?.briefingRunJobs as BriefingRunJobReadService | undefined;
  const job = jobId && jobs ? await jobs.readJob(jobId) : null;
  const ownJob =
    job?.data && job.data.actorUserId === ctx.actorUserId && job.data.briefingRunId === runId;
  const state = !ownJob
    ? "not_found"
    : IN_FLIGHT_JOB_STATES.has(job.state)
      ? "pending"
      : FAILED_JOB_STATES.has(job.state)
        ? "failed"
        : "not_found";

  return {
    data: {
      state,
      runId,
      definitionId: null,
      briefingType: null,
      createdAt: null,
      summaryText: null
    }
  };
}

async function resolveOwnedDefinition(
  scopedDb: DataContextDb,
  input: ToolInput,
  actorUserId: string
): Promise<BriefingDefinition | undefined> {
  const definitionId = typeof input.definitionId === "string" ? input.definitionId : undefined;
  const briefingType = typeof input.briefingType === "string" ? input.briefingType : undefined;
  if ((definitionId === undefined) === (briefingType === undefined)) {
    throw new Error("Give exactly one of briefingType or definitionId");
  }
  if (definitionId !== undefined) {
    if (!UUID_PATTERN.test(definitionId)) return undefined;
    return repository.getOwnedDefinitionById(scopedDb, definitionId);
  }
  if (!BRIEFING_TYPES.has(briefingType!)) {
    throw new Error("briefingType must be morning, evening or weekly_review");
  }
  // listDefinitions is newest-updated first and includes shared definitions; keep owned only.
  const definitions = await repository.listDefinitions(scopedDb);
  return definitions.find(
    (definition) =>
      definition.owner_user_id === actorUserId && definition.briefing_type === briefingType
  );
}

function alreadyRunning(definition: BriefingDefinition, ref: BriefingRunJobRef): ToolResult {
  return {
    data: {
      status: "already_running",
      definitionId: definition.id,
      briefingType: definition.briefing_type,
      runId: ref.runId,
      jobId: ref.jobId
    }
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
