import { requestJson } from "@moss/module-web-sdk";
import type { ChatUnreadResponse } from "@moss/shared";

export function getChatUnread(): Promise<ChatUnreadResponse> {
  return requestJson<ChatUnreadResponse>("/api/chat/unread");
}

export function markChatMessagesRead(threadId: string, messageIds: readonly string[]) {
  return requestJson<{ readonly ok: boolean }>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/read`,
    { method: "POST", body: { messageIds } }
  );
}
