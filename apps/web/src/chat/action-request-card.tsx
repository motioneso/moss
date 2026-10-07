import {
  actionApprovalOutcome,
  actionOutcomeText,
  type ActionRequestDetails,
  type TranscriptRecord
} from "@moss/shared";
import { Button, Card } from "@moss/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ApiError, resolveActionRequest } from "../api/client";
import type { ActionRequestPreview } from "./use-chat-stream";

interface ActionRequestCardProps {
  readonly approvalAvailable?: boolean;
  /** Set only by the native file/shell permission producers, never inferred from tool names. */
  readonly nativePermission?: true;
  /** Host-owned connected-tool request with the complete frozen validated arguments. */
  readonly externalTool?: true;
  readonly exactArguments?: string;
  readonly actionRequestId: string;
  readonly toolName: string;
  readonly summary: string;
  /** Server-derived email preview, including recoverable pending requests after reload. */
  readonly preview?: ActionRequestPreview;
  readonly details?: ActionRequestDetails;
  readonly outsideContentNotice?: boolean;
  readonly outcome?: TranscriptRecord["outcome"];
  readonly decidedBy?: TranscriptRecord["decidedBy"];
  /** Frozen server-owned title, used for both the pending card and its outcome. */
  readonly outcomeTitle?: string;
  readonly reason?: string;
  readonly focusRequested?: boolean;
  readonly onFocusComplete?: () => void;
}

function hasExactArguments(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export function ActionRequestCard(props: ActionRequestCardProps) {
  const admittedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Legacy/restored metadata is not a reviewable disclosure. Never infer presentation from it.
  const [unavailableRequestId, setUnavailableRequestId] = useState<string | null>(null);
  const humanDetails =
    props.details?.presentation === "human" &&
    props.details.target?.trim() &&
    props.details.fields.every((field) => field.label.trim())
      ? props.details
      : undefined;
  const nativeDisclosure =
    props.nativePermission === true && !props.externalTool && Boolean(props.summary.trim());
  const externalDisclosure =
    props.externalTool === true &&
    !props.nativePermission &&
    Boolean(props.toolName.trim()) &&
    hasExactArguments(props.exactArguments);
  const completeDisclosure = props.nativePermission
    ? nativeDisclosure
    : props.externalTool
      ? externalDisclosure
      : Boolean(props.outcomeTitle?.trim() && (humanDetails || props.preview?.to.trim()));
  const missingDisclosure =
    props.approvalAvailable === false ||
    unavailableRequestId === props.actionRequestId ||
    !completeDisclosure;

  const mutation = useMutation<"confirmed" | "rejected", unknown, "confirmed" | "rejected">({
    mutationFn: (next) => resolveActionRequest(props.actionRequestId, next).then(() => next),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "approval_unavailable") {
        setUnavailableRequestId(props.actionRequestId);
      }
    },
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
    if (next === "confirmed" && missingDisclosure) return;
    if (admittedRef.current) return;
    admittedRef.current = true;
    mutation.mutate(next);
  }

  // A missing live disclosure is not a durable timeout; keep its decline control.
  const isExpired =
    mutation.isError &&
    mutation.error instanceof ApiError &&
    mutation.error.status === 409 &&
    mutation.error.code !== "approval_unavailable";
  const errorMessage = mutation.isError
    ? mutation.error instanceof ApiError && mutation.error.code === "approval_unavailable"
      ? null
      : isExpired
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
      <div
        className="action-request-outcome"
        ref={rootRef}
        tabIndex={-1}
        data-action-request-id={props.actionRequestId}
      >
        <p className="chatd-status" role="status">
          {actionOutcomeText({ ...props, summary: props.outcomeTitle }) ??
            `${outcome}${props.outcomeTitle ? ` · ${props.outcomeTitle}` : ""}`}
        </p>
      </div>
    );
  }

  const title = props.outcomeTitle?.trim()
    ? props.outcomeTitle
    : props.nativePermission
      ? "Permission request"
      : props.externalTool
        ? "Connected tool request"
        : "Action request";

  return (
    <div
      className="action-request-card"
      role="region"
      aria-label="Action request"
      aria-busy={mutation.isPending}
      data-action-request-id={props.actionRequestId}
      ref={rootRef}
      tabIndex={-1}
    >
      <Card padding="sm" aria-label={title}>
        <div className="action-request-stack">
          <h2 className="action-request-title">{title}</h2>
          {missingDisclosure ? (
            <p className="jds-hint" role="status">
              Details for this request aren’t available. Reject it and ask Moss again.
            </p>
          ) : (
            <>
              {nativeDisclosure ? (
                <p className="action-request-target action-request-summary">{props.summary}</p>
              ) : externalDisclosure ? (
                <>
                  <p className="action-request-target">{props.toolName}</p>
                  <pre className="action-request-arguments">{props.exactArguments}</pre>
                </>
              ) : humanDetails ? (
                <>
                  <p className="action-request-target">{humanDetails.target}</p>
                  {humanDetails.fields.length > 0 ? (
                    <dl className="action-request-fields">
                      {humanDetails.fields.map((field, index) => (
                        <div className="action-request-field" key={index}>
                          <dt>{field.label}</dt>
                          <dd>{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </>
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
              {props.outsideContentNotice ? (
                <p className="jds-hint action-request-notice">
                  Moss read something from outside your account before asking this.
                </p>
              ) : null}
            </>
          )}
          <div className="action-request-actions">
            {!missingDisclosure ? (
              <Button
                variant={
                  !nativeDisclosure &&
                  !externalDisclosure &&
                  (humanDetails?.approvalKind === "memory_delete" ||
                    humanDetails?.approvalKind === "note_delete")
                    ? "danger"
                    : "primary"
                }
                disabled={mutation.isPending}
                onClick={() => handleResolve("confirmed")}
              >
                Approve
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => handleResolve("rejected")}
            >
              Reject
            </Button>
          </div>
          {mutation.isPending ? (
            <p className="jds-hint" role="status">
              Resolving…
            </p>
          ) : null}
          {errorMessage ? (
            <p className="form-error" role="status">
              {errorMessage}
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
