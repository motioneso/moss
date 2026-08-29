import type {
  ChatMessageDto,
  ChatSurface,
  SourceFreshnessV1,
  WorkflowApprovalDto,
  WorkflowApprovalStatusDto
} from "@moss/shared";
import { useCallback, useEffect, useState } from "react";

import type { AnswerSourceSupportCard, ChatAttachmentDto } from "@moss/shared";

import {
  chatStreamUrl,
  listChatThreadMessages,
  listChatThreads,
  listPendingActionRequests
} from "../api/client.js";
import { listWorkflowApprovals } from "../api/workflows-client.js";

export type ChatRecordKind =
  | "user"
  | "thinking"
  | "tool"
  | "status"
  | "reply"
  | "error"
  | "action_request"
  | "workflow_approval"
  | "action_result";

/**
 * Rich, server-derived Approve/Deny card preview (email reply recipient/subject/body). Rides the
 * live SSE stream ONLY — the backend never persists it. Mirrors `@moss/module-sdk`
 * ActionRequestPreview; declared locally so the web bundle stays free of node-side deps.
 */
export interface ActionRequestPreview {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface TranscriptRecord {
  readonly kind: ChatRecordKind;
  readonly text: string;
  readonly messageId?: string;
  readonly actionRequestId?: string;
  readonly workflowApprovalId?: string;
  readonly toolName?: string;
  readonly summary?: string;
  readonly status?: WorkflowApprovalStatusDto;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
  readonly result?: Record<string, unknown>;
  /** #1310: dot-path tokens into the frontend `queryKeys` object, resolved by app-shell's generic invalidation effect. */
  readonly affectsQueryKeys?: readonly string[];
  readonly answerProvenance?: readonly AnswerSourceSupportCard[];
  readonly answerProvenanceCitedIds?: readonly string[];
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  readonly preview?: ActionRequestPreview;
  /** #1133: chips shown on a sent user message (optimistic, post-response, and history rows). */
  readonly attachments?: readonly ChatAttachmentDto[];
}

function parsePreview(value: unknown): ActionRequestPreview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.to !== "string" ||
    typeof candidate.subject !== "string" ||
    typeof candidate.body !== "string"
  ) {
    return undefined;
  }
  return { to: candidate.to, subject: candidate.subject, body: candidate.body };
}

function isChatRecordKind(value: string): value is ChatRecordKind {
  switch (value) {
    case "user":
    case "thinking":
    case "tool":
    case "status":
    case "reply":
    case "error":
    case "action_request":
    case "workflow_approval":
    case "action_result":
      return true;
    default:
      return false;
  }
}

/**
 * Opens an EventSource against /api/chat/stream and accumulates the live transcript
 * records the backend emits (one JSON record per `data:` event). EventSource handles
 * reconnect automatically; we just append parsed records to local state and close on
 * unmount. `clearRecords` resets the local log (used by the "New chat" action).
 */
export function useChatStream(
  surface?: ChatSurface,
  enabled = true
): {
  readonly records: readonly TranscriptRecord[];
  readonly clearRecords: () => void;
  readonly streamErrorCount: number;
} {
  const [records, setRecords] = useState<readonly TranscriptRecord[]>([]);
  const [streamErrorCount, setStreamErrorCount] = useState(0);

  const clearRecords = useCallback(() => setRecords([]), []);

  useEffect(() => {
    setRecords([]);
    if (!enabled) return;
    const source = new EventSource(chatStreamUrl(surface), { withCredentials: true });

    source.onmessage = (event) => {
      // #1135 — reset error count on successful message so transient errors don't lock private chat
      setStreamErrorCount(0);
      const record = parseRecord(event.data);
      if (record) {
        setRecords((current) => {
          if (record.kind === "reply" && record.messageId) {
            // Replace the last streaming reply (no messageId) with the stored version (has messageId + sourceFreshness)
            const lastUnstored = [...current]
              .reverse()
              .findIndex((r) => r.kind === "reply" && !r.messageId);
            if (lastUnstored !== -1) {
              const realIdx = current.length - 1 - lastUnstored;
              return current.map((r, i) => (i === realIdx ? record : r));
            }
          }
          return [...current, record];
        });
      }
    };

    source.onerror = () => setStreamErrorCount((count) => count + 1);

    return () => source.close();
  }, [enabled, surface]);

  useEffect(() => {
    if (!surface || !enabled) return;
    let active = true;

    const refreshWorkflowApprovals = async () => {
      try {
        const approvals = await listWorkflowApprovals();
        if (!active) return;
        setRecords((current) => mergeWorkflowApprovalRecords(current, approvals));
      } catch {
        // The live stream remains authoritative; an unavailable workflow read must not block chat.
      }
    };

    void (async () => {
      try {
        const [threadsResult, actionsResult, workflowApprovals] = await Promise.all([
          listChatThreads(surface),
          // #1253 — fetch pending action requests to re-hydrate approval cards on page reload
          listPendingActionRequests().catch(() => ({ actions: [] })),
          listWorkflowApprovals().catch(() => [])
        ]);
        const workflowRecords = workflowApprovals.map(workflowApprovalRecord);
        const { threads } = threadsResult;
        const thread = threads[0];
        if (!thread) {
          setRecords((current) => (current.length === 0 ? workflowRecords : current));
          return;
        }
        const { messages } = await listChatThreadMessages(thread.id, surface);
        if (!active) return;
        const history = recordsFromMessages(messages);
        // #1253 — re-hydrate pending action request cards (only "pending" status; others already resolved)
        const pendingActions = actionsResult.actions.filter((a) => a.status === "pending");
        const actionRecords: TranscriptRecord[] = pendingActions.map((action) => {
          const summaryText = action.inputSummary.text;
          return {
            kind: "action_request",
            text:
              typeof summaryText === "string" && summaryText ? summaryText : "Approve this action?",
            actionRequestId: action.id,
            toolName: action.toolName
            // preview is SSE-only; backend never persists it, so re-hydrated cards show no preview
          };
        });
        setRecords((current) =>
          current.length === 0 ? [...history, ...actionRecords, ...workflowRecords] : current
        );
      } catch {
        // The live stream remains authoritative; an unavailable history read must not block chat.
      }
    })();
    const timer = setInterval(() => void refreshWorkflowApprovals(), 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, surface]);

  return { records, clearRecords, streamErrorCount };
}

function workflowApprovalRecord(approval: WorkflowApprovalDto): TranscriptRecord {
  return {
    kind: "workflow_approval",
    text: approval.summary,
    workflowApprovalId: approval.id,
    summary: approval.summary,
    status: approval.status
  };
}

export function mergeWorkflowApprovalRecords(
  records: readonly TranscriptRecord[],
  approvals: readonly WorkflowApprovalDto[]
): TranscriptRecord[] {
  const refreshed = new Map(
    approvals.map((approval) => [approval.id, workflowApprovalRecord(approval)])
  );
  const merged = records.map((record) =>
    record.kind === "workflow_approval" && record.workflowApprovalId
      ? (refreshed.get(record.workflowApprovalId) ?? record)
      : record
  );
  const knownIds = new Set(
    merged.flatMap((record) =>
      record.kind === "workflow_approval" && record.workflowApprovalId
        ? [record.workflowApprovalId]
        : []
    )
  );
  return [
    ...merged,
    ...approvals.filter((approval) => !knownIds.has(approval.id)).map(workflowApprovalRecord)
  ];
}

function recordsFromMessages(messages: readonly ChatMessageDto[]): TranscriptRecord[] {
  return messages.flatMap((message): TranscriptRecord[] => {
    if (message.role === "user") {
      return [
        {
          kind: "user",
          text: message.body,
          messageId: message.id,
          attachments: message.attachments
        }
      ];
    }
    const actionResults: TranscriptRecord[] = message.activity.flatMap((activity) =>
      activity.kind === "action_result" &&
      (activity.outcome === "executed" ||
        activity.outcome === "denied" ||
        activity.outcome === "error" ||
        activity.outcome === "allowed")
        ? [
            {
              kind: "action_result",
              text: activity.text,
              toolName: activity.toolName,
              outcome: activity.outcome
            }
          ]
        : []
    );
    return [
      {
        kind: "reply",
        text: message.body,
        messageId: message.id,
        sourceFreshness: message.sourceFreshness,
        answerProvenance: message.answerProvenance,
        answerProvenanceCitedIds: message.answerProvenanceCitedIds
      },
      ...actionResults
    ];
  });
}

export function shouldEndPrivateChatOnStreamDisconnect(input: {
  readonly privateMode: boolean;
  readonly privateEnded: boolean;
  readonly streamErrorCount: number;
}): boolean {
  return input.privateMode && !input.privateEnded && input.streamErrorCount > 0;
}

export function parseRecord(data: unknown): TranscriptRecord | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.kind !== "string" || typeof parsed.text !== "string") return null;
    if (!isChatRecordKind(parsed.kind)) return null;
    return {
      kind: parsed.kind,
      text: parsed.text,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      actionRequestId:
        typeof parsed.actionRequestId === "string" ? parsed.actionRequestId : undefined,
      workflowApprovalId:
        typeof parsed.workflowApprovalId === "string" ? parsed.workflowApprovalId : undefined,
      toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      status:
        parsed.status === "pending" ||
        parsed.status === "approved" ||
        parsed.status === "denied" ||
        parsed.status === "cancelled"
          ? parsed.status
          : undefined,
      outcome:
        parsed.outcome === "executed" ||
        parsed.outcome === "denied" ||
        parsed.outcome === "error" ||
        parsed.outcome === "allowed"
          ? parsed.outcome
          : undefined,
      result:
        parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
          ? (parsed.result as Record<string, unknown>)
          : undefined,
      affectsQueryKeys:
        Array.isArray(parsed.affectsQueryKeys) &&
        parsed.affectsQueryKeys.every((token) => typeof token === "string")
          ? (parsed.affectsQueryKeys as readonly string[])
          : undefined,
      sourceFreshness:
        parsed.sourceFreshness && typeof parsed.sourceFreshness === "object"
          ? (parsed.sourceFreshness as SourceFreshnessV1)
          : undefined,
      preview: parsePreview(parsed.preview)
    };
  } catch {
    return null;
  }
}
