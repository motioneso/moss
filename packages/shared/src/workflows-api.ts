/**
 * HTTP contracts for the owner-scoped workflow run endpoints (#2013, slice 819-B).
 *
 * These are what an HTTP client sees, which is deliberately less than what the database
 * holds: no artifact bytes, no vault reference, and no run input beyond bounded origin
 * metadata. See safeArtifact/safeRun in packages/workflows/src/routes.ts.
 */

export type WorkflowRunStatusDto =
  | "pending"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepRunStatusDto =
  | "pending"
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowApprovalStatusDto = "pending" | "approved" | "denied" | "cancelled";

export type WorkflowRunStartedByDto = "user" | "module" | "system";

export interface WorkflowRunDto {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly moduleId: string;
  readonly status: WorkflowRunStatusDto;
  readonly startedBy: WorkflowRunStartedByDto;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowStepRunDto {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepId: string;
  readonly status: WorkflowStepRunStatusDto;
  readonly attemptCount: number;
  readonly errorCode: string | null;
  readonly startedAt: string | null;
  readonly suspendedAt: string | null;
  readonly completedAt: string | null;
}

export interface WorkflowApprovalDto {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly status: WorkflowApprovalStatusDto;
  readonly summary: string;
  readonly resolvedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Metadata only — never the vault reference the bytes live behind, and never the bytes. */
export interface WorkflowArtifactDto {
  readonly id: string;
  readonly workflowRunId: string;
  readonly stepRunId: string | null;
  readonly sha256: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface WorkflowRunDetailDto extends WorkflowRunDto {
  readonly steps: readonly WorkflowStepRunDto[];
  readonly approvals: readonly WorkflowApprovalDto[];
  readonly artifacts: readonly WorkflowArtifactDto[];
}

export interface ListWorkflowRunsQuery {
  readonly status?: WorkflowRunStatusDto;
  readonly limit?: number;
}

export type ListWorkflowRunsResponse = readonly WorkflowRunDto[];

export interface CancelWorkflowRunResponse {
  readonly cancelled: boolean;
  readonly run: WorkflowRunDto;
}

export interface ResolveWorkflowApprovalRequest {
  readonly decision: "approve" | "deny";
}

export interface ResolveWorkflowApprovalResponse {
  readonly approval: WorkflowApprovalDto;
  readonly step: WorkflowStepRunDto;
}
