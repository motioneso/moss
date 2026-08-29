import type {
  ListWorkflowRunsQuery,
  ListWorkflowRunsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  WorkflowApprovalDto,
  WorkflowRunDetailDto
} from "@moss/shared";

import { requestJson } from "./client.js";

export async function listWorkflowRuns(
  query: ListWorkflowRunsQuery = {}
): Promise<ListWorkflowRunsResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<ListWorkflowRunsResponse>(`/api/workflows/runs${suffix}`);
}

export function getWorkflowRunDetail(runId: string): Promise<WorkflowRunDetailDto> {
  return requestJson<WorkflowRunDetailDto>(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export async function listWorkflowApprovals(): Promise<readonly WorkflowApprovalDto[]> {
  const runs = await listWorkflowRuns({ status: "running", limit: 100 });
  const details = await Promise.all(runs.map((run) => getWorkflowRunDetail(run.id)));
  return details.flatMap((detail) => detail.approvals);
}

export async function resolveWorkflowApproval(
  approvalId: string,
  decision: ResolveWorkflowApprovalRequest["decision"]
): Promise<ResolveWorkflowApprovalResponse> {
  return requestJson<ResolveWorkflowApprovalResponse>(
    `/api/workflows/approvals/${encodeURIComponent(approvalId)}/resolve`,
    { method: "POST", body: { decision } }
  );
}
