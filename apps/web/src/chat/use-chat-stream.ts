import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import type {
  ActionRequestDetails,
  ChatActivityEventDto,
  ChatMessageDto,
  ChatSurface,
  SourceFreshnessV1,
  WorkflowApprovalDto
} from "@moss/shared";
import { useCallback, useEffect, useRef, useState } from "react";

// The transcript shape lives in `@moss/shared` now (defined once for the shell and every module
// thread); re-exported here so existing importers keep working while they migrate over.
import type { ActionRequestPreview, ChatRecordKind, TranscriptRecord } from "@moss/shared";

export type { ActionRequestPreview, ChatRecordKind, TranscriptRecord };

import {
  chatStreamUrl,
  getMe,
  listChatThreadMessages,
  listChatThreads,
  listPendingActionRequests,
  resumeChat
} from "../api/client.js";
import { listWorkflowApprovals } from "../api/workflows-client.js";
import {
  applyStreamRecord,
  mergeBackgroundRecords,
  mergeHydratedRecords,
  upsertTranscriptRecord
} from "./stream-record-identity.js";

export { upsertTranscriptRecord };

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

function parseDetails(value: unknown): ActionRequestDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.target !== null && typeof candidate.target !== "string") return undefined;
  if (!Array.isArray(candidate.fields)) return undefined;
  const fields: { label: string; value: string }[] = [];
  for (const field of candidate.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
    if (typeof field.label !== "string" || !field.label.trim() || typeof field.value !== "string")
      return undefined;
    fields.push({ label: field.label, value: field.value });
  }
  if (candidate.presentation !== undefined && candidate.presentation !== "human") return undefined;
  const approvalKind = candidate.approvalKind;
  if (
    approvalKind !== undefined &&
    approvalKind !== "memory_delete" &&
    approvalKind !== "note_delete"
  )
    return undefined;
  return {
    target: candidate.target,
    fields,
    ...(candidate.presentation === "human" ? { presentation: "human" as const } : {}),
    ...(approvalKind ? { approvalKind } : {})
  };
}

function parseStringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isChatRecordKind(value: string): value is ChatRecordKind {
  switch (value) {
    case "user":
    case "thinking":
    case "thought":
    case "tool":
    case "result":
    case "approval":
    case "approved":
    case "not_approved":
    case "refusal":
    case "refused":
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

const STREAM_RETRY_BASE_MS = 1_000;
const STREAM_RETRY_MAX_MS = 30_000;

/** Delay before reopening a refused stream: 1s, 2s, 4s, ... capped at 30s. */
export function streamRetryDelayMs(retries: number): number {
  return Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** retries);
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
  readonly selectionPending: boolean;
} {
  const [records, setRecords] = useState<readonly TranscriptRecord[]>([]);
  const [streamErrorCount, setStreamErrorCount] = useState(0);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [hydratedSurface, setHydratedSurface] = useState<ChatSurface>();
  const hydrationGeneration = useRef(0);
  // The owned Main thread this drawer hydrated, so a reconnect can catch up its reminders.
  const hydratedMainThread = useRef<string | undefined>(undefined);
  const streamScope = useRef({ surface, enabled });
  streamScope.current = { surface, enabled };

  const clearRecords = useCallback(() => {
    hydrationGeneration.current += 1;
    setRecords([]);
    setStreamGeneration(hydrationGeneration.current);
    setHydratedSurface(streamScope.current.surface);
  }, []);

  useEffect(() => {
    setRecords([]);
    if (!enabled) return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let disposed = false;
    const generation = hydrationGeneration.current;
    const isCurrent = () =>
      !disposed &&
      generation === hydrationGeneration.current &&
      streamScope.current.enabled &&
      streamScope.current.surface === surface;

    // A reconnect has no backlog, so a reminder delivered while disconnected is read back from
    // Main's history. Only background messages are merged; the live stream owns the rest.
    let connectedBefore = false;
    const catchUpMain = () => {
      const threadId = hydratedMainThread.current;
      if (!threadId) return;
      void listChatThreadMessages(threadId, surface)
        .then(({ messages }) => {
          if (!isCurrent() || hydratedMainThread.current !== threadId) return;
          setRecords((current) =>
            isCurrent() ? mergeBackgroundRecords(current, recordsFromMessages(messages)) : current
          );
        })
        .catch(() => undefined);
    };

    const open = () => {
      if (!isCurrent()) return;
      const stream = new EventSource(chatStreamUrl(surface), { withCredentials: true });
      source = stream;
      // A connected stream clears earlier failures, so a recovered stream never ends a new
      // private chat. A private chat already ended stays ended in the drawer.
      stream.onopen = () => {
        if (!isCurrent()) return;
        retries = 0;
        setStreamErrorCount(0);
        if (connectedBefore) catchUpMain();
        connectedBefore = true;
      };
      stream.onmessage = (event) => {
        if (!isCurrent()) return;
        // #1135 — reset error count on successful message so transient errors don't lock private chat
        setStreamErrorCount(0);
        const record = parseRecord(event.data);
        if (record) {
          setRecords((current) => (isCurrent() ? applyStreamRecord(current, record) : current));
        }
      };

      stream.onerror = () => {
        if (!isCurrent()) return;
        setStreamErrorCount((count) => count + 1);
        // EventSource retries a dropped connection itself, but an HTTP error response closes it
        // for good. Reopen it, or later action results never reach the drawer (#2737).
        if (disposed || stream.readyState !== EventSource.CLOSED) return;
        stream.close();
        retryTimer = setTimeout(open, streamRetryDelayMs(retries));
        retries += 1;
      };
    };
    open();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, surface, streamGeneration]);

  useEffect(() => {
    setHydratedSurface(undefined);
    hydratedMainThread.current = undefined;
    if (!surface || !enabled) return;
    let active = true;
    const generation = hydrationGeneration.current;

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
        const isDrawer = surface === undefined || surface === DEFAULT_CHAT_SURFACE;
        const [threadsResult, workflowApprovals, viewer] = await Promise.all([
          listChatThreads(surface),
          listWorkflowApprovals().catch(() => []),
          isDrawer ? getMe() : undefined
        ]);
        if (!active || generation !== hydrationGeneration.current) return;
        const workflowRecords = workflowApprovals.map(workflowApprovalRecord);
        const { threads } = threadsResult;
        const ownedThreads = isDrawer
          ? threads.filter((candidate) => candidate.ownerUserId === viewer?.user.id)
          : threads;
        const thread = isDrawer
          ? (ownedThreads.find((candidate) => candidate.isMain) ?? ownedThreads[0])
          : threads[0];
        if (!thread) {
          setRecords((current) => (current.length === 0 ? workflowRecords : current));
          return;
        }
        // The browser's startup is a cold drawer selection even when another tab left a warm
        // side-chat engine behind. Route it through the authenticated resume seam before reading
        // history, so the displayed transcript and the next turn bind to the same Main thread.
        if (isDrawer && thread.isMain) {
          await resumeChat(thread.id, surface);
          if (!active || generation !== hydrationGeneration.current) return;
        }
        // Recovery may persist overdue outcomes. Finish it before fetching history so the
        // first reload includes those outcomes instead of an empty, already-expired card.
        const actionsResult = await listPendingActionRequests(thread.id).catch(() => ({
          actions: []
        }));
        if (!active || generation !== hydrationGeneration.current) return;
        const { messages } = await listChatThreadMessages(thread.id, surface);
        if (!active || generation !== hydrationGeneration.current) return;
        const history = recordsFromMessages(messages);
        if (isDrawer && thread.isMain) hydratedMainThread.current = thread.id;
        // #1253 — re-hydrate pending action request cards (only "pending" status; others already resolved)
        const pendingActions = actionsResult.actions.filter((a) => a.status === "pending");
        const actionRecords: TranscriptRecord[] = pendingActions.map((action) => {
          const summaryText = action.inputSummary.text;
          return {
            kind: "action_request",
            text:
              action.presentation?.summary ??
              (typeof summaryText === "string" && summaryText ? summaryText : "Action request"),
            actionRequestId: action.id,
            toolName: action.toolName,
            approvalAvailable:
              action.approvalAvailable === true && action.presentation !== undefined,
            ...(action.presentation
              ? {
                  summary: action.presentation.summary,
                  nativePermission: action.presentation.nativePermission,
                  externalTool: action.presentation.externalTool,
                  exactArguments: action.presentation.exactArguments,
                  outcomeTitle: action.presentation.outcomeTitle,
                  details: action.presentation.details,
                  preview: action.presentation.preview,
                  outsideContentNotice: action.presentation.outsideContentNotice
                }
              : {})
          };
        });
        setRecords((current) =>
          mergeHydratedRecords(current, [...history, ...actionRecords, ...workflowRecords])
        );
      } catch {
        // The live stream remains authoritative; an unavailable history read must not block chat.
      } finally {
        if (active && generation === hydrationGeneration.current) setHydratedSurface(surface);
      }
    })();
    const timer = setInterval(() => void refreshWorkflowApprovals(), 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, surface]);

  return {
    records,
    clearRecords,
    streamErrorCount,
    selectionPending: enabled && surface !== undefined && hydratedSurface !== surface
  };
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

export function recordsFromMessages(messages: readonly ChatMessageDto[]): TranscriptRecord[] {
  return messages.flatMap((message): TranscriptRecord[] => {
    if (message.role === "user") {
      return [
        {
          kind: "user",
          text: message.body,
          messageId: message.id,
          meetingContext: message.meetingContext,
          attachments: message.attachments
        }
      ];
    }
    const activity = message.activity;
    return [
      ...activity.map(activityRecord),
      ...(activity.some((event) => event.kind === "tool")
        ? []
        : message.tools.map((tool) => ({
            kind: "tool" as const,
            text: tool.name
          }))),
      // Late action outcomes can be persisted without an assistant reply body.
      ...(message.body
        ? [
            {
              kind: message.status === "error" ? ("error" as const) : ("reply" as const),
              text: message.body,
              messageId: message.id,
              ...(isDeliveredReminder(message) ? { background: true as const } : {}),
              sourceFreshness: message.sourceFreshness,
              meetingContext: message.meetingContext,
              answerProvenance: message.answerProvenance,
              answerProvenanceCitedIds: message.answerProvenanceCitedIds,
              ...(message.elapsedMs !== undefined ? { elapsedMs: message.elapsedMs } : {}),
              ...(message.usage !== undefined ? { usage: message.usage } : {})
            }
          ]
        : [])
    ];
  });
}

function isDeliveredReminder(message: ChatMessageDto): boolean {
  return message.origin?.kind === "reminder" && message.origin.event === "delivered";
}

function activityRecord(activity: ChatActivityEventDto): TranscriptRecord {
  return {
    kind: isChatRecordKind(activity.kind) ? activity.kind : "status",
    text: activity.text,
    ...(activity.actionRequestId !== undefined
      ? { actionRequestId: activity.actionRequestId }
      : {}),
    ...(activity.summary !== undefined ? { summary: activity.summary } : {}),
    ...(activity.id !== undefined ? { id: activity.id } : {}),
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    ...(activity.toolName !== undefined ? { toolName: activity.toolName } : {}),
    ...(activity.toolCallId !== undefined ? { toolCallId: activity.toolCallId } : {}),
    ...(activity.outcome !== undefined ? { outcome: activity.outcome } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
    ...(activity.decidedBy !== undefined ? { decidedBy: activity.decidedBy } : {}),
    ...(activity.reason !== undefined ? { reason: activity.reason } : {})
  };
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
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      sequence: typeof parsed.sequence === "number" ? parsed.sequence : undefined,
      messageId: typeof parsed.messageId === "string" ? parsed.messageId : undefined,
      turnId: typeof parsed.turnId === "string" ? parsed.turnId : undefined,
      background: parsed.background === true ? true : undefined,
      actionRequestId:
        typeof parsed.actionRequestId === "string" ? parsed.actionRequestId : undefined,
      workflowApprovalId:
        typeof parsed.workflowApprovalId === "string" ? parsed.workflowApprovalId : undefined,
      toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
      toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      nativePermission: parsed.nativePermission === true ? true : undefined,
      externalTool: parsed.externalTool === true ? true : undefined,
      exactArguments: typeof parsed.exactArguments === "string" ? parsed.exactArguments : undefined,
      outcomeTitle: typeof parsed.outcomeTitle === "string" ? parsed.outcomeTitle : undefined,
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
      affectsQueryKeys: parseStringList(parsed.affectsQueryKeys),
      affectsModules: parseStringList(parsed.affectsModules),
      sourceFreshness:
        parsed.sourceFreshness && typeof parsed.sourceFreshness === "object"
          ? (parsed.sourceFreshness as SourceFreshnessV1)
          : undefined,
      preview: parsePreview(parsed.preview),
      details: parseDetails(parsed.details),
      outsideContentNotice:
        typeof parsed.outsideContentNotice === "boolean" ? parsed.outsideContentNotice : undefined,
      decidedBy:
        parsed.decidedBy === "person" ||
        parsed.decidedBy === "policy" ||
        parsed.decidedBy === "timeout" ||
        parsed.decidedBy === "cancelled"
          ? parsed.decidedBy
          : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
      elapsedMs: typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : undefined,
      usage: parseUsage(parsed.usage)
    };
  } catch {
    return null;
  }
}

function parseUsage(value: unknown): TranscriptRecord["usage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
    "thoughtTokens",
    "totalTokens"
  ]) {
    if (typeof usage[key] === "number") result[key] = usage[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function reconcileFallbacks(
  fallbacks: readonly TranscriptRecord[],
  liveRecords: readonly TranscriptRecord[]
): readonly TranscriptRecord[] {
  const unmatched = [...liveRecords];
  return fallbacks.filter((fallback) => {
    const idx = unmatched.findIndex(
      (record) =>
        record.kind === fallback.kind &&
        (record.messageId && fallback.messageId
          ? record.messageId === fallback.messageId
          : record.text === fallback.text)
    );
    if (idx === -1) return true;
    unmatched.splice(idx, 1);
    return false;
  });
}
