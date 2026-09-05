import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookmarkPlus,
  ChevronDown,
  MoreHorizontal,
  Paperclip,
  ThumbsDown,
  ThumbsUp,
  Undo2
} from "lucide-react";
import { useState } from "react";

import type {
  ChatAttachmentDto,
  SourceFreshnessEntry,
  SourceFreshnessV1,
  UsefulnessFeedbackDto,
  UsefulnessFeedbackKind
} from "@moss/shared";
import { Menu } from "@moss/ui";

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
import { WorkflowApprovalCard } from "./workflow-approval-card";
import type { ChatRecordKind, TranscriptRecord } from "./use-chat-stream";

/**
 * Message/record rendering for the chat drawer, extracted from chat-drawer.tsx (#1133) —
 * the drawer file sat at the 1000-line file-size gate and the attachment chips pushed it
 * over. Pure presentation: all state and data flow stay in the drawer.
 */

export function Thread(props: {
  readonly records: readonly TranscriptRecord[];
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
  /**
   * Whether a turn is still running. When given, a trailing step group only reads as
   * "Thinking..." while this is true; when omitted, a trailing group (no reply after it yet)
   * is treated as still in progress.
   */
  readonly working?: boolean;
}) {
  return (
    <div className="chatd-thread" aria-live="polite">
      {groupRecords(props.records, props.working).map((item, index) =>
        item.type === "activity" ? (
          <ActivityPeek key={index} records={item.records} inProgress={item.inProgress} />
        ) : item.type === "status" ? (
          <StatusLine key={index} record={item.record} />
        ) : (
          <RecordRow
            key={index}
            record={item.record}
            focusActionRequestId={props.focusActionRequestId}
            onActionRequestFocused={props.onActionRequestFocused}
          />
        )
      )}
    </div>
  );
}

const ACTIVITY_KINDS: ReadonlySet<ChatRecordKind> = new Set<ChatRecordKind>([
  "thinking",
  "tool",
  "status"
]);

type RenderItem =
  | { readonly type: "record"; readonly record: TranscriptRecord }
  | { readonly type: "status"; readonly record: TranscriptRecord }
  | {
      readonly type: "activity";
      readonly records: readonly TranscriptRecord[];
      readonly inProgress: boolean;
    };

/**
 * Status records ("I'll get today's top headlines for you.") surface in the thread as their own
 * quiet lines so it is obvious the assistant is working; thinking and tool steps collapse into
 * one "Thinking..." line per turn, placed after the statuses and just above the reply. The line
 * is never removed once the reply lands — it stays for historical context. (Note: only action
 * results are persisted server-side, so restored conversations carry no steps to show.)
 */
export function groupRecords(
  records: readonly TranscriptRecord[],
  working?: boolean
): RenderItem[] {
  const items: RenderItem[] = [];
  let buffer: TranscriptRecord[] = [];

  const flush = (inProgress: boolean) => {
    if (buffer.length > 0) {
      items.push({ type: "activity", records: buffer, inProgress });
      buffer = [];
    }
  };

  for (const record of records) {
    if (record.kind === "status") {
      items.push({ type: "status", record });
    } else if (ACTIVITY_KINDS.has(record.kind) && record.kind !== "action_request") {
      buffer.push(record);
    } else {
      flush(false);
      items.push({ type: "record", record });
    }
  }
  flush(working ?? true);
  return items;
}

/** Note 2 — a status update shown inline in the thread, quieter than a reply bubble. */
function StatusLine(props: { readonly record: TranscriptRecord }) {
  return (
    <p className="chatd-status" role="status">
      {props.record.text}
    </p>
  );
}

export function ActivityPeek(props: {
  readonly records: readonly TranscriptRecord[];
  readonly inProgress?: boolean;
}) {
  const count = props.records.length;
  const inProgress = props.inProgress ?? false;
  return (
    <details className="chatd-peek chatd-peek--quiet" data-in-progress={inProgress || undefined}>
      <summary className="chatd-peek__summary chatd-peek__summary--quiet">
        <span className="chatd-peek__label">{inProgress ? "Thinking..." : "Thinking"}</span>
        {inProgress ? null : (
          <span className="chatd-peek__count">{`${count} ${count === 1 ? "step" : "steps"}`}</span>
        )}
        <ChevronDown className="chatd-peek__chev" size={12} aria-hidden="true" />
      </summary>
      <div className="chatd-peek__body">
        {props.records.map((record, index) => (
          <div className="chatd-peek__line" key={index}>
            <span className="chatd-peek__kind">{activityVerb(record)}</span>
            {record.text}
          </div>
        ))}
      </div>
    </details>
  );
}

export function activityVerb(record: TranscriptRecord): string {
  if (record.kind === "action_result") {
    // #1661: "allowed" no longer implies unattended mode (a user's own approval reports it too,
    // because the gateway sees the grant and not the run), and "error" is not a denial — the
    // audit row for that event says the handler failed, which is a different thing from the user
    // or a policy refusing it.
    return record.outcome === "allowed"
      ? "Allowed"
      : record.outcome === "executed"
        ? "Executed"
        : record.outcome === "error"
          ? "Failed"
          : "Denied";
  }
  return `${record.kind} ·`;
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

function RecordRow(props: {
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
    // #1888 — workshop.buildModule hands back a plan for the user to approve. It is the only
    // action result that owns a card; everything else stays the one-line outcome note below.
    if (props.record.toolName === "workshop.buildModule") {
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

function chatFreshnessLabel(entry: SourceFreshnessEntry, capturedAt: string): string {
  if (entry.freshnessKind === "realtime") return "live";
  if (!entry.asOf) return "unknown";
  const ageMs = new Date(capturedAt).getTime() - new Date(entry.asOf).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

const CHAT_SOURCE_LABEL: Record<string, string> = {
  email: "Email",
  calendar: "Calendar",
  vault: "Notes",
  tasks: "Tasks",
  commitments: "Commitments",
  chats: "Chats",
  goals: "Goals"
};

export function ChatFreshnessFooter({
  sourceFreshness
}: {
  readonly sourceFreshness?: SourceFreshnessV1 | null;
}) {
  if (!sourceFreshness) return null;
  const summaryNames = sourceFreshness.sources
    .map((e) => CHAT_SOURCE_LABEL[e.source] ?? e.source)
    .join(", ");
  return (
    <details className="chatd-freshness chatd-peek">
      <summary className="chatd-peek__summary">
        <span className="chatd-peek__label">Sources</span>
        <span className="chatd-peek__count">{summaryNames}</span>
        <svg
          className="chatd-peek__chev"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <ul className="chatd-freshness__list chatd-peek__body">
        {sourceFreshness.sources.map((entry) => (
          <li key={entry.source} className="chatd-freshness__item chatd-peek__line">
            <span className="chatd-freshness__source">
              {CHAT_SOURCE_LABEL[entry.source] ?? entry.source}
            </span>
            <span className="chatd-freshness__age" title={entry.asOf ?? undefined}>
              {chatFreshnessLabel(entry, sourceFreshness.capturedAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
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
