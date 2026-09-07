import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookmarkPlus,
  MoreHorizontal,
  Paperclip,
  ThumbsDown,
  ThumbsUp,
  Undo2
} from "lucide-react";
import { useState } from "react";

import type {
  ChatAttachmentDto,
  TranscriptRecord,
  UsefulnessFeedbackDto,
  UsefulnessFeedbackKind
} from "@moss/shared";
import { ChatFreshnessFooter, Menu, activityVerb } from "@moss/ui";

import { queryKeys } from "../api/query-keys";
import {
  createUsefulnessFeedback,
  undoUsefulnessFeedback
} from "../api/usefulness-feedback-client";
import { BrandMark } from "../shell/brand-mark";
import { ActionRequestCard } from "./action-request-card";
import { formatAttachmentSize } from "./attachments";
import { MarkdownMessage } from "./markdown-message";
import { ModuleBuildPlanRecord, parseModuleBuildPlanResult } from "./module-build-plan-record";
import { WorkshopProjectRecord, parseWorkshopProjectResult } from "./workshop-project-record";
import { WorkflowApprovalCard } from "./workflow-approval-card";

/**
 * The shell's full row renderer for the shared `Thread` (moved to `@moss/ui`): approval cards,
 * markdown replies, feedback, attachments and freshness. Module threads use the thread's
 * built-in default rows instead — this file keeps only what the drawer alone needs.
 */

export function RecordRow(props: {
  readonly record: TranscriptRecord;
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
}) {
  const { kind, text } = props.record;

  if (kind === "action_request" && props.record.actionRequestId) {
    return (
      <ActionRequestCard
        actionRequestId={props.record.actionRequestId}
        summary={props.record.summary ?? text}
        toolName={props.record.toolName ?? kind}
        preview={props.record.preview}
        focusRequested={props.record.actionRequestId === props.focusActionRequestId}
        onFocusComplete={props.onActionRequestFocused}
      />
    );
  }

  if (kind === "workflow_approval" && props.record.workflowApprovalId) {
    return (
      <WorkflowApprovalCard
        approvalId={props.record.workflowApprovalId}
        summary={props.record.summary ?? text}
        status={props.record.status}
      />
    );
  }

  if (kind === "user") {
    return (
      <div className="chatd-msg chatd-msg--me">
        <AttachmentChips attachments={props.record.attachments} />
        {text ? <div className="chatd-bubble">{text}</div> : null}
        {props.record.messageId ? (
          <ChatFeedbackMenu messageId={props.record.messageId} canRemember />
        ) : null}
      </div>
    );
  }

  if (kind === "error") {
    return <p className="form-error">{text}</p>;
  }

  if (kind === "action_result") {
    // New handoffs open a saved project. Retain rendering for historical plan records.
    if (props.record.toolName === "workshop.buildModule") {
      const project = parseWorkshopProjectResult(props.record.result);
      if (project) return <WorkshopProjectRecord {...project} />;
      const parsed = parseModuleBuildPlanResult(props.record.result);
      if (parsed) {
        return (
          <ModuleBuildPlanRecord
            buildId={parsed.buildId}
            plan={parsed.plan}
            awaitingApproval={parsed.awaitingApproval}
          />
        );
      }
    }

    return (
      <div className="chatd-peek__line" role="status">
        <span className="chatd-peek__kind">{activityVerb(props.record)}</span>
        {text}
      </div>
    );
  }

  // reply (and any unforeseen non-activity kind) — assistant bubble, rendered as markdown.
  return (
    <div className="chatd-msg">
      <span className="chatd-msg__av">
        <BrandMark size={14} />
      </span>
      <div className="chatd-bubble">
        <MarkdownMessage
          text={text}
          answerProvenance={props.record.answerProvenance}
          answerProvenanceCitedIds={props.record.answerProvenanceCitedIds}
        />
      </div>
      <ChatFreshnessFooter sourceFreshness={props.record.sourceFreshness} />
      {props.record.messageId ? (
        <ChatFeedbackMenu messageId={props.record.messageId} canRemember={false} corner />
      ) : null}
    </div>
  );
}

/** #1133 — read-only chips on a sent user message showing what rode along with it. */
export function AttachmentChips(props: { readonly attachments?: readonly ChatAttachmentDto[] }) {
  if (!props.attachments || props.attachments.length === 0) return null;
  return (
    <div className="chatd-attach__sent">
      {props.attachments.map((attachment) => (
        <span
          className="chatd-attach__chip is-sent"
          key={attachment.id}
          title={attachment.fileName}
        >
          <Paperclip size={12} aria-hidden="true" />
          <span className="chatd-attach__name">{attachment.fileName}</span>
          <span className="chatd-attach__meta">{formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      ))}
    </div>
  );
}

function ChatFeedbackMenu(props: {
  readonly messageId: string;
  readonly canRemember: boolean;
  /** Note 3 — pin to the top-right of the assistant message and show only on hover/focus. */
  readonly corner?: boolean;
}) {
  const queryClient = useQueryClient();
  const [last, setLast] = useState<UsefulnessFeedbackDto | null>(null);
  const createMutation = useMutation({
    mutationFn: (kind: UsefulnessFeedbackKind) =>
      createUsefulnessFeedback({
        targetKind: "chat_message",
        targetRef: props.messageId,
        surface: "chat",
        kind
      }),
    onSuccess: (response) => {
      setLast(response.feedback);
      void queryClient.invalidateQueries({ queryKey: queryKeys.usefulnessFeedback.list });
    }
  });
  const undoMutation = useMutation({
    mutationFn: (id: string) => undoUsefulnessFeedback(id),
    onSuccess: () => {
      setLast(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.usefulnessFeedback.list });
    }
  });

  const className = [
    "feedback-menu",
    props.corner ? "feedback-menu--corner" : null,
    last ? "is-saved" : null
  ]
    .filter(Boolean)
    .join(" ");

  const items = [
    {
      id: "more_like_this",
      label: "More like this",
      icon: <ThumbsUp size={13} aria-hidden="true" />,
      disabled: createMutation.isPending
    },
    {
      id: "not_useful",
      label: "Not useful",
      icon: <ThumbsDown size={13} aria-hidden="true" />,
      disabled: createMutation.isPending
    },
    ...(props.canRemember
      ? [
          {
            id: "remember_this",
            label: "Remember this",
            icon: <BookmarkPlus size={13} aria-hidden="true" />,
            disabled: createMutation.isPending
          }
        ]
      : [])
  ];

  return (
    <div className={className}>
      <Menu
        triggerIcon={<MoreHorizontal size={14} aria-hidden="true" />}
        triggerLabel="Feedback"
        items={items}
        onSelect={(id) => createMutation.mutate(id as UsefulnessFeedbackKind)}
      />
      {last ? (
        <span className="feedback-menu__status">
          Saved
          <button
            type="button"
            onClick={() => undoMutation.mutate(last.id)}
            disabled={undoMutation.isPending}
          >
            <Undo2 size={12} aria-hidden="true" />
            Undo
          </button>
        </span>
      ) : null}
    </div>
  );
}
