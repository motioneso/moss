import type { DataContextRunner } from "@moss/db";
import type { AiRepository, GatewaySessionRecord, SessionNotifier } from "@moss/ai";
import type { ChatSessionManager } from "./live/chat-session-manager.js";
import { parseSurfaceSessionKey } from "./live/chat-surface.js";
import type { TranscriptRecord } from "./live/types.js";

export type ActionOriginLookup = (
  actorUserId: string,
  actionRequestId: string,
  chatSessionId: string
) => Promise<{ readonly found: boolean; readonly threadId?: string | null }>;

/** Route action records by their durable request origin, never by the selected surface. */
export class ChatGatewayNotifier implements SessionNotifier {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly manager: ChatSessionManager,
    private readonly lookupOrigin?: ActionOriginLookup
  ) {}

  emit(chatSessionId: string, record: GatewaySessionRecord): void {
    const queued = (this.pending.get(chatSessionId) ?? Promise.resolve())
      .then(async () => {
        const transcriptRecord = toTranscriptRecord(record);
        if (!transcriptRecord || !this.lookupOrigin) return;
        let actorUserId = chatSessionId;
        let surface: string | undefined;
        try {
          ({ actorUserId, surface } = parseSurfaceSessionKey(chatSessionId));
        } catch {
          // Bare actor keys are legacy transport identities, never conversation identities.
        }
        const origin = await this.lookupOrigin(actorUserId, record.actionRequestId, chatSessionId);
        const threadId = origin.found
          ? origin.threadId
          : record.kind === "action_result" && record.decidedBy === "policy"
            ? record.originThreadId
            : undefined;
        if (!threadId) return;
        if (record.kind === "action_result" && record.historyOnly) {
          await this.manager.injectOriginRecord(
            actorUserId,
            threadId,
            transcriptRecord,
            surface,
            true
          );
        } else {
          await this.manager.injectOriginRecord(actorUserId, threadId, transcriptRecord, surface);
        }
      })
      .catch(() => {
        // Unknown or unavailable ownership/origin must never redirect into another chat.
      });
    this.pending.set(chatSessionId, queued);
    void queued.then(() => {
      if (this.pending.get(chatSessionId) === queued) this.pending.delete(chatSessionId);
    });
  }

  /** Wait for admitted notifications before a controlled shutdown or a route-level test. */
  async flush(chatSessionId?: string): Promise<void> {
    if (chatSessionId) await this.pending.get(chatSessionId);
    else await Promise.all(this.pending.values());
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
      ...(record.outcomeTitle ? { outcomeTitle: record.outcomeTitle } : {}),
      outsideContentNotice: record.outsideContentNotice,
      ...(record.details ? { details: record.details } : {}),
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
      ...(record.summary
        ? { summary: record.summary.replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
      ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
      ...(record.holdDurationMs != null ? { durationMs: record.holdDurationMs } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.affectsQueryKeys ? { affectsQueryKeys: record.affectsQueryKeys } : {}),
      ...(record.affectsModules ? { affectsModules: record.affectsModules } : {})
    };
  }
  return null;
}

export function createChatGatewayNotifier(
  manager: ChatSessionManager,
  runner: DataContextRunner,
  repository: AiRepository | undefined
): ChatGatewayNotifier {
  return new ChatGatewayNotifier(manager, async (actorUserId, actionRequestId, chatSessionId) => {
    if (!repository) return { found: false };
    return runner.withDataContext({ actorUserId }, async (scopedDb) => {
      const action = await repository.getAssistantAction(scopedDb, actionRequestId);
      return action
        ? {
            found: true,
            threadId:
              action.owner_user_id === actorUserId && action.chat_session_id === chatSessionId
                ? action.chat_thread_id
                : null
          }
        : { found: false };
    });
  });
}
