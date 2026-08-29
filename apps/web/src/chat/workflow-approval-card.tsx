import { useMutation } from "@tanstack/react-query";
import { CheckCircle, LoaderCircle, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WorkflowApprovalStatusDto, ResolveWorkflowApprovalResponse } from "@moss/shared";

import { ApiError } from "../api/client.js";
import { resolveWorkflowApproval } from "../api/workflows-client.js";

export interface WorkflowApprovalCardProps {
  readonly approvalId: string;
  readonly summary: string;
  readonly status?: WorkflowApprovalStatusDto;
}

export function WorkflowApprovalCard(props: WorkflowApprovalCardProps) {
  const admittedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mutation = useMutation<ResolveWorkflowApprovalResponse, unknown, "approve" | "deny">({
    mutationFn: (decision) => resolveWorkflowApproval(props.approvalId, decision),
    onSettled: () => {
      admittedRef.current = false;
    }
  });

  useEffect(() => {
    if (mutation.isSuccess || mutation.isError) rootRef.current?.focus();
  }, [mutation.isSuccess, mutation.isError]);

  const resolvedStatus: WorkflowApprovalStatusDto =
    mutation.data?.approval.status ?? props.status ?? "pending";
  const alreadyAnswered =
    mutation.isError && mutation.error instanceof ApiError && mutation.error.status === 409;
  const errorMessage = alreadyAnswered
    ? "This approval has already been answered"
    : mutation.error instanceof Error
      ? mutation.error.message
      : mutation.isError
        ? "Could not resolve this approval"
        : null;

  function resolve(decision: "approve" | "deny") {
    if (admittedRef.current || mutation.isPending || resolvedStatus !== "pending") return;
    admittedRef.current = true;
    mutation.mutate(decision);
  }

  const stateLabel =
    resolvedStatus === "approved"
      ? "Approved"
      : resolvedStatus === "denied"
        ? "Not approved"
        : resolvedStatus === "cancelled"
          ? "Cancelled"
          : "Needs your approval";

  return (
    <div
      className="action-request-card"
      role="region"
      aria-label="Workflow approval"
      data-workflow-approval-id={props.approvalId}
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="action-request-preview__label" data-state={resolvedStatus}>
        {stateLabel}
      </div>
      <p className="action-request-summary">{props.summary}</p>

      {mutation.isPending ? (
        <p className="muted-text">
          <LoaderCircle className="spin" size={14} aria-hidden="true" /> Resolving…
        </p>
      ) : resolvedStatus !== "pending" ? null : alreadyAnswered ? (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      ) : (
        <div className="action-request-actions">
          <button
            className="primary-button"
            type="button"
            disabled={mutation.isPending}
            onClick={() => resolve("approve")}
          >
            <CheckCircle size={16} aria-hidden="true" />
            Approve
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={mutation.isPending}
            onClick={() => resolve("deny")}
          >
            <XCircle size={16} aria-hidden="true" />
            Reject
          </button>
          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        </div>
      )}
    </div>
  );
}
