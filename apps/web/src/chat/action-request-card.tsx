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
  readonly focusRequested?: boolean;
  readonly onFocusComplete?: () => void;
}

export function ActionRequestCard(props: ActionRequestCardProps) {
  const admittedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation<"confirmed" | "rejected", unknown, "confirmed" | "rejected">({
    mutationFn: (next) => resolveActionRequest(props.actionRequestId, next).then(() => next),
    onSettled: () => {
      admittedRef.current = false;
    }
  });

  useEffect(() => {
    if (mutation.isSuccess || mutation.isError) {
      rootRef.current?.focus();
    }
  }, [mutation.isSuccess, mutation.isError]);

  useEffect(() => {
    if (!props.focusRequested) return;
    rootRef.current?.scrollIntoView({ block: "center" });
    rootRef.current?.focus();
    props.onFocusComplete?.();
  }, [props.focusRequested, props.onFocusComplete]);

  function handleResolve(next: "confirmed" | "rejected") {
    if (admittedRef.current) return;
    admittedRef.current = true;
    mutation.mutate(next);
  }

  // #1250 — server returns 409 for expired requests; card stays showing expiration message
  const isExpired =
    mutation.isError && mutation.error instanceof ApiError && mutation.error.status === 409;
  const errorMessage = mutation.isError
    ? isExpired
      ? "This request expired — ask again."
      : mutation.error instanceof Error
        ? mutation.error.message
        : "Could not resolve"
    : null;

  return (
    <div
      className="action-request-card"
      role="region"
      aria-label="Action request"
      data-action-request-id={props.actionRequestId}
      ref={rootRef}
      tabIndex={-1}
    >
      {/* The eyebrow used to be the tool's own name with the dots stripped, which put "SET" and
          "SET-ENABLED" above the card — a verb with its object thrown away, and an internal
          identifier shown to someone who never chose it. The summary underneath already says what
          the action does in plain words, so the eyebrow's real job here is to mark the card as a
          decision and then say how it went. `data-state` rather than a second class so the styling
          hook and the text stay derived from one value. */}
      <div
        className="action-request-preview__label"
        data-state={mutation.isSuccess ? mutation.data : "pending"}
      >
        {mutation.isSuccess
          ? mutation.data === "rejected"
            ? "Not approved"
            : "Approved"
          : "Needs your approval"}
      </div>
      <p className="action-request-summary">{props.summary}</p>

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
          <button
            className="primary-button"
            type="button"
            onClick={() => handleResolve("confirmed")}
          >
            <CheckCircle size={16} aria-hidden="true" />
            Approve
          </button>
          <button className="ghost-button" type="button" onClick={() => handleResolve("rejected")}>
            <XCircle size={16} aria-hidden="true" />
            Reject
          </button>
          {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        </div>
      )}
    </div>
  );
}
