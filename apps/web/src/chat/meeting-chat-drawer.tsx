import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Chip } from "@moss/ui";
import { requestJson } from "@moss/module-web-sdk";
import { meetingChatSurface, type MeetingChatSelection } from "@moss/shared";
import { listChatThreads, listChatThreadMessages } from "../api/client";
import { ChatDrawer } from "./chat-drawer";
import { recordsFromMessages } from "./use-chat-stream";

/** Access is checked before history is mounted; no stale title or snippets on failure. */
export function MeetingChatDrawer(props: {
  readonly selection: MeetingChatSelection & { readonly title: string };
  readonly onClose: () => void;
  readonly isFounder: boolean;
  readonly docked?: boolean;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
}) {
  const { selection } = props;
  const surface = meetingChatSurface(selection.meetingId);
  const [cleared, setCleared] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const access = useQuery({
    queryKey: ["meeting-chat-access", selection.selectionId],
    queryFn: ({ signal }) =>
      requestJson<{ available: true }>(`/api/chat/meeting-context?surface=${surface}`, { signal }),
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
    refetchOnWindowFocus: "always"
  });
  const history = useQuery({
    queryKey: ["meeting-chat-history", selection.selectionId],
    queryFn: async () => {
      const { threads } = await listChatThreads(surface);
      return threads[0] ? (await listChatThreadMessages(threads[0].id, surface)).messages : [];
    },
    enabled: access.isSuccess && access.data.available === true && !unavailable,
    gcTime: 0,
    retry: false
  });
  if (!access.isSuccess || access.data.available !== true || history.isError || unavailable) {
    return (
      <aside
        className={`chatd${props.docked ? " chatd--docked" : ""}`}
        role="dialog"
        aria-label="Meeting chat"
      >
        <div className="chatd__head">
          <Chip onRemove={props.onClose}>
            {access.isError || history.isError || unavailable
              ? "Meeting unavailable"
              : "Loading meeting…"}
          </Chip>
        </div>
      </aside>
    );
  }
  return (
    <ChatDrawer
      key={selection.selectionId}
      open
      docked={props.docked}
      expanded={props.expanded}
      onToggleExpanded={props.onToggleExpanded}
      onClose={props.onClose}
      records={cleared ? [] : recordsFromMessages(history.data ?? [])}
      clearRecords={() => setCleared(true)}
      streamErrorCount={0}
      isFounder={props.isFounder}
      surface={surface}
      meetingContext={selection}
      onMeetingUnavailable={() => setUnavailable(true)}
    />
  );
}
