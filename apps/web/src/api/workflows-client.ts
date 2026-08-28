import type { ResolveWorkflowApprovalRequest, ResolveWorkflowApprovalResponse } from "@moss/shared";

import { requestJson } from "./client.js";

export async function resolveWorkflowApproval(
  approvalId: string,
  decision: ResolveWorkflowApprovalRequest["decision"]
): Promise<ResolveWorkflowApprovalResponse> {
  return requestJson<ResolveWorkflowApprovalResponse>(
    `/api/workflows/approvals/${encodeURIComponent(approvalId)}/resolve`,
    { method: "POST", body: { decision } }
  );
}
