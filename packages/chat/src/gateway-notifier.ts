import type { GatewaySessionRecord, SessionNotifier } from "@moss/ai";
import type { ChatSessionManager } from "./live/chat-session-manager.js";
import { parseSurfaceSessionKey } from "./live/chat-surface.js";
import type { TranscriptRecord } from "./live/types.js";

/**
 * Bridges the AssistantToolGateway's SessionNotifier to ChatSessionManager's
 * subscriber fan-out. Composite session IDs carry the actor and surface;
 * bare actor IDs remain supported for existing callers.
 */
export class ChatGatewayNotifier implements SessionNotifier {
  constructor(private readonly manager: ChatSessionManager) {}

  emit(chatSessionId: string, record: GatewaySessionRecord): void {
    const transcriptRecord = toTranscriptRecord(record);
    if (transcriptRecord) {
      try {
        const { actorUserId, surface } = parseSurfaceSessionKey(chatSessionId);
        this.manager.injectRecord(actorUserId, transcriptRecord, surface);
      } catch {
        this.manager.injectRecord(chatSessionId, transcriptRecord);
      }
    }
  }
}

function toTranscriptRecord(record: GatewaySessionRecord): TranscriptRecord | null {
  if (record.kind === "action_request") {
    return {
      kind: "action_request",
      text: `Approve or deny: ${record.summary}`,
      actionRequestId: record.actionRequestId,
      toolName: record.toolName,
      summary: record.summary,
      // Rides the live stream only; never persisted (see TranscriptRecord.preview).
      ...(record.preview ? { preview: record.preview } : {})
    };
  }
  if (record.kind === "action_result") {
    const statusText =
      record.outcome === "executed" && typeof record.result?.statusText === "string"
        ? record.result.statusText.replace(/\s+/g, " ").trim().slice(0, 160)
        : "";
    // #1661: three separate outcomes used to collapse into two sentences.
    //
    // "allowed" said "Allowed by YOLO" because unattended mode was once its only source. It is
    // not any more — a user approving a native tool now reports "allowed" too, because the
    // gateway only ever sees the grant and never the run — so the text can no longer name a
    // cause it does not know.
    //
    // "error" fell into the denial sentence, so a tool that ran and failed was announced as
    // "Not changed", the same words as a refusal. The audit row for that same event says
    // `failed`, and "not changed" additionally asserts something the host cannot know: a write
    // that failed part-way did change things.
    const text =
      statusText ||
      (record.outcome === "allowed"
        ? `Allowed: ${record.toolName}`
        : record.outcome === "executed"
          ? `Executed: ${record.toolName}`
          : record.outcome === "error"
            ? `Failed: ${record.toolName}${record.reason ? ` — ${record.reason}` : ""}`
            : `Not changed${record.reason ? ` — ${record.reason}` : ""}`);
    return {
      kind: "action_result",
      text,
      actionRequestId: record.actionRequestId,
      toolName: record.toolName,
      outcome: record.outcome,
      ...(record.result ? { result: record.result } : {}),
      ...(record.affectsQueryKeys ? { affectsQueryKeys: record.affectsQueryKeys } : {})
    };
  }
  return null;
}
