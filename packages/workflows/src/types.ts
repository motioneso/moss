/**
 * Workflow persistence types (#2013, slice 819-B).
 *
 * Mirrors packages/workflows/sql/0202_workflow_runs.sql. Nothing here executes a workflow —
 * the queue, worker and retry scheduling belong to #2014, and the vault artifact write port
 * to #2015.
 */

/**
 * Bound on every JSON column this module stores. Kept in step with the
 * `octet_length(...) <= 8192` CHECK constraints in 0202_workflow_runs.sql. The repository
 * checks it before the insert so a caller gets an error naming the field instead of a raw
 * database constraint violation.
 */
export const WORKFLOW_MAX_JSON_BYTES = 8192;

/** Cap on how many runs a single list call will return. */
export const WORKFLOW_RUN_LIST_MAX_LIMIT = 100;

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowApprovalStatus = "pending" | "approved" | "denied" | "cancelled";

/** How a run was started. See the spec's "Run Origins" section for the exact meanings. */
export type WorkflowRunStartedBy = "user" | "module" | "system";

export type WorkflowApprovalDecision = "approve" | "deny";

/**
 * States a step run can never leave. A worker that comes back from a crash must not be able
 * to resurrect a step that was already finished or cancelled underneath it.
 */
export const TERMINAL_STEP_RUN_STATUSES: readonly WorkflowStepRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled"
];

/** Run statuses that mean the run is over. */
export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled"
];

export type WorkflowJson = Record<string, unknown>;

export interface WorkflowRun {
  readonly id: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly moduleId: string;
  readonly status: WorkflowRunStatus;
  readonly startedBy: WorkflowRunStartedBy;
  readonly inputJson: WorkflowJson;
  readonly resultJson: WorkflowJson;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkflowStepRun {
  readonly id: string;
  readonly workflowRunId: string;
  readonly ownerUserId: string;
  readonly stepId: string;
  readonly status: WorkflowStepRunStatus;
  readonly attemptCount: number;
  readonly inputJson: WorkflowJson;
  readonly resultJson: WorkflowJson;
  readonly errorCode: string | null;
  readonly queueJobId: string | null;
  readonly startedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkflowApproval {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly ownerUserId: string;
  readonly status: WorkflowApprovalStatus;
  readonly summary: string;
  readonly detailsJson: WorkflowJson;
  readonly resolvedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Reference metadata for a stored artifact. `artifactRef` never leaves the server: the route
 * layer strips it before responding (see safeArtifact in routes.ts).
 */
export interface WorkflowArtifact {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepRunId: string | null;
  readonly ownerUserId: string;
  readonly artifactRef: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkflowRunDetail {
  readonly run: WorkflowRun;
  readonly stepRuns: readonly WorkflowStepRun[];
  readonly approvals: readonly WorkflowApproval[];
  readonly artifacts: readonly WorkflowArtifact[];
}

export interface CreateWorkflowRunInput {
  readonly ownerUserId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly moduleId: string;
  readonly startedBy: WorkflowRunStartedBy;
  readonly inputJson?: WorkflowJson;
  readonly startStepId: string;
  readonly startStepInputJson?: WorkflowJson;
}

export interface CreateWorkflowStepRunInput {
  readonly workflowRunId: string;
  readonly ownerUserId: string;
  readonly stepId: string;
  readonly inputJson?: WorkflowJson;
}

export interface CreateWorkflowApprovalInput {
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly ownerUserId: string;
  readonly summary: string;
  readonly detailsJson?: WorkflowJson;
}

export interface RecordWorkflowArtifactInput {
  readonly workflowRunId: string;
  readonly stepRunId: string | null;
  readonly ownerUserId: string;
  readonly artifactRef: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface CreateWorkflowRunResult {
  readonly run: WorkflowRun;
  readonly firstStepRun: WorkflowStepRun;
}

/**
 * `created` is false when the unique constraint on (workflow_run_id, step_id) collided; the
 * existing row comes back rather than null, which is what the queue slice (#2014) relies on
 * to make a duplicate job delivery a no-op.
 */
export interface CreateWorkflowStepRunResult {
  readonly stepRun: WorkflowStepRun;
  readonly created: boolean;
}

/** `cancelled` is false when the run had already reached a terminal state. Not an error. */
export interface CancelWorkflowRunResult {
  readonly cancelled: boolean;
  readonly run: WorkflowRun | null;
  readonly cancelledStepRunCount: number;
  readonly cancelledApprovalCount: number;
}

export type ResolveWorkflowApprovalResult =
  | {
      readonly outcome: "resolved";
      readonly approval: WorkflowApproval;
      readonly stepRun: WorkflowStepRun;
    }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "not-pending" };

/**
 * Raised when a caller tries to move a step run out of a state the spec calls terminal, or
 * when a stored JSON value would exceed WORKFLOW_MAX_JSON_BYTES. Carries a machine-readable
 * code so routes can map it to a status without string matching.
 */
export class WorkflowStateError extends Error {
  readonly code: "terminal-state" | "value-too-large" | "not-found";
  /** Fastify's default error handler reads this, so routes need no custom handler. */
  readonly statusCode: number;

  constructor(code: "terminal-state" | "value-too-large" | "not-found", message: string) {
    super(message);
    this.name = "WorkflowStateError";
    this.code = code;
    this.statusCode = code === "not-found" ? 404 : 422;
  }
}
