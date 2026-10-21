import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { Button, EmptyState } from "@moss/ui";

import { ApiError, getChatMessageLocation } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { webRoutePath } from "../app-route-metadata";
import { useChatControls } from "../shell/chat-controls-context";

/**
 * #3481: the landing for a link to one chat message, such as a reminder alert. A found message
 * opens its chat focused on that message over Notifications. A missing or foreign one stays
 * here and says so, without naming anything about it.
 */
export function ChatMessageLinkPage() {
  const { messageId = "" } = useParams();
  const navigate = useNavigate();
  const { openChat, openChatThread } = useChatControls();
  const opened = useRef(false);
  const location = useQuery({
    queryKey: queryKeys.chat.messageLocation(messageId),
    queryFn: () => getChatMessageLocation(messageId),
    enabled: messageId.length > 0,
    retry: false,
    staleTime: 0
  });

  useEffect(() => {
    if (!location.data || opened.current) return;
    opened.current = true;
    openChatThread(location.data.threadId, location.data.messageId);
    void navigate(webRoutePath("notifications"), { replace: true });
  }, [location.data, navigate, openChatThread]);

  const gone =
    messageId.length === 0 || (location.error instanceof ApiError && location.error.status === 404);

  return (
    <section className="page-stack" aria-busy={location.isPending && !gone}>
      {gone ? (
        <EmptyState
          title="This message is not available"
          description="It was deleted, or it is not in your chats."
        >
          <Button variant="quiet" onClick={openChat}>
            Open chat
          </Button>
        </EmptyState>
      ) : location.isError ? (
        <EmptyState title="Could not open this message">
          <Button variant="quiet" onClick={() => void location.refetch()}>
            Retry
          </Button>
        </EmptyState>
      ) : null}
    </section>
  );
}
