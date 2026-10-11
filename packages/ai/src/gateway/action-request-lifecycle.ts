import { randomUUID } from "node:crypto";
import type { AccessContext, DataContextRunner } from "@moss/db";

import type { AiRepository, AiAssistantActionRequestSafeRow } from "../repository.js";
import type {
  AwaitOutcome,
  ConfirmationRegistry,
  ResolutionStatus
} from "./confirmation-registry.js";
import { emitActionResultRecord } from "./action-result-record.js";
import type { GatewaySessionRecord, SessionNotifier } from "./types.js";

export function emitPendingActionRequest(
  deps: { readonly confirmations: ConfirmationRegistry; readonly notifier: SessionNotifier },
  actorUserId: string,
  chatSessionId: string,
  action: AiAssistantActionRequestSafeRow,
  record: Extract<GatewaySessionRecord, { kind: "action_request" }>
): void {
  const { liveOrigin: _untrustedOrigin, ...presentation } = record;
  const bound = {
    ...presentation,
    ...(action.id === record.actionRequestId &&
    action.owner_user_id === actorUserId &&
    action.chat_session_id === chatSessionId &&
    action.chat_thread_id
      ? { liveOrigin: { actorUserId, chatSessionId, threadId: action.chat_thread_id } }
      : {})
  };
  deps.confirmations.storePresentation(actorUserId, bound);
  deps.notifier.emit(chatSessionId, bound);
}

interface ActionRequestStore {
  readonly runner: DataContextRunner;
  readonly repository: Pick<
    AiRepository,
    "getAssistantAction" | "resolveAssistantAction" | "expireAssistantAction"
  >;
}

/** The pending-only update is the arbiter between a timer and an explicit decision. */
export async function expireActionRequest(
  deps: ActionRequestStore,
  access: AccessContext,
  actionId: string
) {
  return deps.runner.withDataContext(access, async (scopedDb) => {
    const expired = await deps.repository.expireAssistantAction(scopedDb, actionId);
    return {
      changed: Boolean(expired),
      action: expired ?? (await deps.repository.getAssistantAction(scopedDb, actionId))
    };
  });
}

export function awaitActionResolution(
  deps: ActionRequestStore & {
    readonly confirmations: ConfirmationRegistry;
    readonly confirmTimeoutMs: number;
  },
  access: AccessContext,
  actionId: string,
  sessionId?: string,
  turnId?: string
): Promise<AwaitOutcome> {
  return deps.confirmations.awaitResolution(
    actionId,
    deps.confirmTimeoutMs,
    sessionId,
    turnId,
    async (outcome) => {
      const action =
        outcome === "timeout"
          ? (await expireActionRequest(deps, access, actionId)).action
          : await deps.runner.withDataContext(
              access,
              async (db) =>
                (await deps.repository.resolveAssistantAction(db, actionId, {
                  status: "cancelled"
                })) ?? (await deps.repository.getAssistantAction(db, actionId))
            );
      if (!action) return "cancelled";
      if (action.status === "pending") throw new Error("Action resolution could not be recorded");
      return action.status === "timed_out" ? "timeout" : action.status;
    }
  );
}

/** Resolve only owned requests; expired waiters can never grant a later execution. */
export async function resolvePersistedActionRequest(
  deps: ActionRequestStore & {
    readonly confirmations: ConfirmationRegistry;
    readonly notifier: SessionNotifier;
  },
  actorUserId: string,
  actionRequestId: string,
  status: ResolutionStatus
): Promise<"resolved" | "expired" | "unavailable" | "not_found"> {
  const access = { actorUserId, requestId: `mcp_${randomUUID()}` };
  if (status === "confirmed") {
    const action = await deps.runner.withDataContext(access, (db) =>
      deps.repository.getAssistantAction(db, actionRequestId)
    );
    if (action?.status === "timed_out") return "expired";
    if (!action || action.status !== "pending") return "not_found";
    if (
      !deps.confirmations.isAwaiting(actionRequestId) ||
      !deps.confirmations.getPresentation(actorUserId, actionRequestId)
    ) {
      const expired = await expireActionRequest(deps, access, actionRequestId);
      if (expired.changed && expired.action?.chat_session_id) {
        emitActionResultRecord(deps.notifier, expired.action.chat_session_id, {
          actionRequestId,
          ...(expired.action.chat_thread_id
            ? { originThreadId: expired.action.chat_thread_id }
            : {}),
          toolName: expired.action.tool_name,
          outcome: "denied",
          decidedBy: "timeout",
          reason: "Action timed out."
        });
      }
      return expired.action?.status === "timed_out"
        ? "expired"
        : expired.action?.status === "pending"
          ? "unavailable"
          : "not_found";
    }
  }
  const hadWaiter = deps.confirmations.isAwaiting(actionRequestId);
  const stored: { action?: AiAssistantActionRequestSafeRow } = {};
  const resolved = await deps.confirmations.resolveAndAwaitCompletion(
    actionRequestId,
    status,
    async () => {
      stored.action = await deps.runner.withDataContext(access, (db) =>
        deps.repository.resolveAssistantAction(db, actionRequestId, { status })
      );
      return Boolean(stored.action);
    }
  );
  if (resolved) {
    const action = stored.action;
    if (!hadWaiter && status !== "confirmed" && action?.chat_thread_id && action.chat_session_id) {
      emitActionResultRecord(deps.notifier, action.chat_session_id, {
        actionRequestId: action.id,
        originThreadId: action.chat_thread_id,
        toolName: action.tool_name,
        outcome: "denied",
        decidedBy: status === "rejected" ? "person" : "cancelled",
        reason: status === "rejected" ? "You declined this action." : "Action cancelled."
      });
      await deps.notifier.flush?.(action.chat_session_id);
    }
    return "resolved";
  }
  const current =
    status === "confirmed"
      ? (await expireActionRequest(deps, access, actionRequestId)).action
      : await deps.runner.withDataContext(access, (db) =>
          deps.repository.getAssistantAction(db, actionRequestId)
        );
  return status === "confirmed" && current?.status === "timed_out" ? "expired" : "not_found";
}
