import type { BriefingRun } from "@moss/db";
import type {
  BriefingPlanContextV1,
  BriefingRunPlanStatus,
  BriefingRunReadState
} from "@moss/shared";

/** Single 404 body for every unreadable run, so runs cannot be probed. */
export const RUN_NOT_AVAILABLE_ERROR = "Briefing run is missing or owned by someone else";
export const RUN_NOT_AVAILABLE_CODE = "briefing_run_not_available";

/** 409 code when a repeated idempotency key finds the first run still queued. */
export const RUN_IN_FLIGHT_CODE = "briefing_run_in_flight";

const PENDING_JOB_STATES: ReadonlySet<string> = new Set(["created", "retry", "active"]);
const FAILED_JOB_STATES: ReadonlySet<string> = new Set(["failed", "cancelled"]);

export interface RunStatusJob {
  readonly state: string;
  readonly data: {
    readonly actorUserId?: unknown;
    readonly briefingRunId?: unknown;
  } | null;
}

export type ResolvedRunStatus =
  | { readonly state: BriefingRunReadState; readonly latest: boolean }
  | { readonly notFound: true };

/**
 * Pure read-state decision for one briefing run. A stored row is ready; without
 * a row only the caller's own queued job for that run counts, and a completed
 * job without a row is gone, not pending. Never sleeps, retries or polls.
 */
export function resolveRunStatus(args: {
  readonly run: BriefingRun | undefined;
  readonly runDefinitionId: string | undefined;
  readonly definitionId: string;
  readonly firstRunId: string | undefined;
  readonly job: RunStatusJob | null | undefined;
  readonly actorUserId: string;
  readonly runId: string;
}): ResolvedRunStatus {
  if (args.run && args.runDefinitionId === args.definitionId) {
    return { state: "ready", latest: args.firstRunId === args.run.id };
  }
  const job = args.job;
  if (
    job?.data &&
    job.data.actorUserId === args.actorUserId &&
    job.data.briefingRunId === args.runId
  ) {
    if (PENDING_JOB_STATES.has(job.state)) {
      return { state: "pending", latest: false };
    }
    if (job.state === "completed") {
      return { notFound: true };
    }
    if (FAILED_JOB_STATES.has(job.state)) {
      return { state: "failed", latest: false };
    }
    return { state: "failed", latest: false };
  }
  return { notFound: true };
}

export interface PlanStateInput {
  /** Stored context from the run payload; null when the run predates plan context. */
  readonly stored: BriefingPlanContextV1 | null;
  /** False when no read port is wired or the read threw. */
  readonly currentAvailable: boolean;
  /** Current projection; null when the actor holds no plan for that day. */
  readonly current: BriefingPlanContextV1 | null;
}

/**
 * Pure four-way plan comparison. Reports whether the saved plan moved since the
 * run was written; it never rebases, rewrites or recomputes anything.
 */
export function comparePlanState(input: PlanStateInput): {
  readonly status: BriefingRunPlanStatus;
  readonly storedRevision: number | null;
  readonly currentRevision: number | null;
} {
  const storedRevision = input.stored?.revision ?? null;
  if (!input.currentAvailable) {
    return { status: "unavailable", storedRevision, currentRevision: null };
  }
  const currentRevision = input.current?.revision ?? null;
  if (!input.stored && !input.current) {
    return { status: "none", storedRevision, currentRevision };
  }
  if (
    input.stored &&
    input.current &&
    input.stored.planId === input.current.planId &&
    input.stored.revision === input.current.revision
  ) {
    return { status: "current", storedRevision, currentRevision };
  }
  return { status: "changed", storedRevision, currentRevision };
}
