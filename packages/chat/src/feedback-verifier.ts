import { createHash } from "node:crypto";
import type { FeedbackTargetVerifier } from "@moss/usefulness-feedback";

import { ChatRepository } from "./repository.js";

const REMEMBER_EXCERPT_CHARS = 1000;

export function createChatFeedbackTargetVerifier(
  repository = new ChatRepository()
): FeedbackTargetVerifier {
  return async (scopedDb, input) => {
    if (input.targetKind !== "chat_message" || input.surface !== "chat") return null;
    const message = await repository.getMessageById(scopedDb, input.targetRef);
    if (!message || message.owner_user_id !== input.actorUserId) return null;
    if (
      message.tool_metadata &&
      typeof message.tool_metadata === "object" &&
      "meetingChatV1" in message.tool_metadata
    )
      return null;
    const thread = await repository.getThreadById(scopedDb, message.thread_id);
    if (!thread || thread.owner_user_id !== input.actorUserId) return null;

    const canRemember = !thread.incognito && message.role === "user" && message.status === "stored";
    return {
      approvalTarget: {
        label: message.body,
        version: createHash("sha256")
          .update(
            JSON.stringify([
              message.id,
              message.thread_id,
              message.role,
              message.status,
              message.body,
              thread.incognito
            ])
          )
          .digest("hex")
      },
      ownerUserId: input.actorUserId,
      targetKind: input.targetKind,
      targetRef: input.targetRef,
      surface: input.surface,
      sourceKind: "chat",
      sourceLabel: "Chat",
      metadata: { role: message.role, status: message.status },
      canRemember,
      rememberExcerpt: canRemember ? message.body.slice(0, REMEMBER_EXCERPT_CHARS) : undefined
    };
  };
}
