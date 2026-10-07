import {
  actionApprovalOutcome,
  actionOutcomeText,
  type ActionRequestDetails,
  type TranscriptRecord
} from "@moss/shared";
import { Button } from "@moss/ui";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle, LoaderCircle, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";

import { ApiError, resolveActionRequest } from "../api/client";
import type { ActionRequestPreview } from "./use-chat-stream";

interface ActionRequestCardProps {
  readonly actionRequestId: string;
  readonly toolName: string;
  readonly summary: string;
  /** Rich server-derived preview (email reply recipient/subject/body); live-stream only. */
  readonly preview?: ActionRequestPreview;
  readonly details?: ActionRequestDetails;
  readonly outsideContentNotice?: boolean;
  readonly outcome?: TranscriptRecord["outcome"];
  readonly decidedBy?: TranscriptRecord["decidedBy"];
  /** Terminal server-owned title; pending summaries may contain technical request details. */
  readonly outcomeTitle?: string;
  readonly reason?: string;
  readonly focusRequested?: boolean;
  readonly onFocusComplete?: () => void;
}

export function ActionRequestCard(props: ActionRequestCardProps) {
  const admittedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Pending cards restored after reload have metadata only. Never approve a memory blind.
  const missingMemoryTarget = props.toolName === "memory.forget" && !props.details?.target?.trim();

  const mutation = useMutation<"confirmed" | "rejected", unknown, "confirmed" | "rejected">({
    mutationFn: (next) => resolveActionRequest(props.actionRequestId, next).then(() => next),
    onSettled: () => {
      admittedRef.current = false;
    }
  });

  const policyRefusal = props.decidedBy === "policy" && props.outcome === "denied";

  useEffect(() => {
    if (mutation.isSuccess || mutation.isError || actionApprovalOutcome(props) || policyRefusal) {
      rootRef.current?.focus();
    }
  }, [mutation.isSuccess, mutation.isError, props.outcome, props.decidedBy, policyRefusal]);

  useEffect(() => {
    if (!props.focusRequested) return;
    rootRef.current?.scrollIntoView({ block: "center" });
    rootRef.current?.focus();
    props.onFocusComplete?.();
  }, [props.focusRequested, props.onFocusComplete]);

  function handleResolve(next: "confirmed" | "rejected") {
    if (next === "confirmed" && missingMemoryTarget) return;
    if (admittedRef.current) return;
    admittedRef.current = true;
    mutation.mutate(next);
  }

  // #1250 — only an owned, still-pending request with no live waiter returns 409.
  const isExpired =
    mutation.isError && mutation.error instanceof ApiError && mutation.error.status === 409;
  const errorMessage = mutation.isError
    ? isExpired
      ? "This request expired — ask again."
      : mutation.error instanceof Error
        ? mutation.error.message
        : "Could not resolve"
    : null;

  const outcome =
    (policyRefusal ? actionOutcomeText({ ...props, summary: props.outcomeTitle }) : null) ??
    actionApprovalOutcome(props) ??
    (mutation.isSuccess
      ? mutation.data === "rejected"
        ? "You declined"
        : "Approved"
      : isExpired
        ? "Timed out"
        : null);
  if (outcome) {
    return (
      <div ref={rootRef} tabIndex={-1} data-action-request-id={props.actionRequestId}>
        <p className="chatd-status" role="status">
          {actionOutcomeText({ ...props, summary: props.outcomeTitle }) ??
            `${outcome}${props.outcomeTitle ? ` · ${props.outcomeTitle}` : ""}`}
        </p>
      </div>
    );
  }

  return (
    <div
      className="action-request-card"
      role="region"
      aria-label="Action request"
      data-action-request-id={props.actionRequestId}
      ref={rootRef}
      tabIndex={-1}
      style={{ display: "grid", gap: "var(--space-3)" }}
    >
      {/* The eyebrow used to be the tool's own name with the dots stripped, which put "SET" and
          "SET-ENABLED" above the card — a verb with its object thrown away, and an internal
          identifier shown to someone who never chose it. The summary underneath already says what
          the action does in plain words, so the eyebrow's real job here is to mark the card as a
          decision and then say how it went. `data-state` rather than a second class so the styling
          hook and the text stay derived from one value. */}
      <div className="action-request-preview__label" data-state="pending">
        Needs your approval
      </div>
      <p className="action-request-summary">{props.summary}</p>

      {props.details && (props.details.target !== null || props.details.fields.length > 0) ? (
        <dl className="action-request-preview__meta">
          {props.details.target !== null ? (
            <div className="action-request-preview__row">
              <dt className="action-request-preview__label">Target</dt>
              <dd className="action-request-preview__value action-request-preview__value--multiline">
                <q>{props.details.target}</q>
              </dd>
            </div>
          ) : null}
          {props.details.fields.map((field, index) => (
            <div className="action-request-preview__row" key={index}>
              <dt className="action-request-preview__label">{field.label}</dt>
              <dd className="action-request-preview__value" style={{ whiteSpace: "pre-wrap" }}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {missingMemoryTarget && !mutation.isSuccess ? (
        <p className="muted-text" role="status">
          Memory details are unavailable. Reject this request and ask again.
        </p>
      ) : null}

      {props.outsideContentNotice ? (
        <p className="muted-text">
          This chat has outside or unverified context, so changes need your approval.
        </p>
      ) : null}

      {props.preview ? (
        <div className="action-request-preview">
          <dl className="action-request-preview__meta">
            <div className="action-request-preview__row">
              <dt className="action-request-preview__label">To</dt>
              <dd className="action-request-preview__value">{props.preview.to}</dd>
            </div>
            <div className="action-request-preview__row">
              <dt className="action-request-preview__label">Subject</dt>
              <dd className="action-request-preview__value">{props.preview.subject}</dd>
            </div>
          </dl>
          <p className="action-request-preview__body">{props.preview.body}</p>
        </div>
      ) : null}

      {mutation.isPending ? (
        <p className="muted-text">
          <LoaderCircle className="spin" size={14} aria-hidden="true" /> Resolving…
        </p>
      ) : mutation.isSuccess ? null : isExpired ? (
        <p className="form-error">{errorMessage}</p>
      ) : (
        <div className="action-request-actions">
          {!missingMemoryTarget ? (
            <Button
              icon={<CheckCircle size={16} aria-hidden="true" />}
              onClick={() => handleResolve("confirmed")}
            >
              Approve
            </Button>
          ) : null}
          <Button
            variant="quiet"
            icon={<XCircle size={16} aria-hidden="true" />}
            onClick={() => handleResolve("rejected")}
          >
            Reject
          </Button>
          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        </div>
      )}
    </div>
  );
}
