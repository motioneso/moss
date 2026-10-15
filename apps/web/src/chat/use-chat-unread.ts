import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TranscriptRecord } from "@moss/shared";
import { getChatUnread, markChatMessagesRead } from "../api/chat-unread-client.js";
import { queryKeys } from "../api/query-keys.js";

export function useChatUnread(ownerId: string) {
  return useQuery({
    queryKey: queryKeys.chat.unread(ownerId),
    queryFn: getChatUnread,
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always"
  });
}

export function useReadChatMessages(input: {
  readonly ownerId?: string;
  readonly threadId: string | null;
  readonly visible: boolean;
  readonly records: readonly TranscriptRecord[];
}) {
  const queryClient = useQueryClient();
  const [tabVisible, setTabVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "visible"
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  // Stable IDs, rather than records-array identity, avoid re-acknowledging every render.
  const messageIds = JSON.stringify(
    [
      ...new Set(
        input.records.flatMap((record) =>
          record.kind === "reply" && record.messageId ? [record.messageId] : []
        )
      )
    ].sort()
  );
  const { ownerId, threadId, visible } = input;
  useEffect(() => {
    if (!ownerId || !threadId || !visible || !tabVisible) return;
    const ids = JSON.parse(messageIds) as string[];
    if (ids.length === 0) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const acknowledge = async () => {
      try {
        for (let offset = 0; offset < ids.length; offset += 500) {
          if (cancelled || document.visibilityState !== "visible") return;
          await markChatMessagesRead(threadId, ids.slice(offset, offset + 500));
        }
        if (!cancelled)
          await queryClient.invalidateQueries({ queryKey: queryKeys.chat.unread(ownerId) });
      } catch {
        if (!cancelled) retry = setTimeout(() => void acknowledge(), 5_000);
      }
    };
    void acknowledge();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [ownerId, threadId, visible, tabVisible, messageIds, queryClient]);
}
