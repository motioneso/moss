import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Chip } from "@moss/ui";
import { ApiError as ModuleApiError, requestJson } from "@moss/module-web-sdk";
import { meetingChatSurface, type MeetingChatSelection, type MeetingRecord } from "@moss/shared";
import { ApiError, listChatThreads, listChatThreadMessages } from "../api/client";
import { ChatDrawer } from "./chat-drawer";
import { recordsFromMessages } from "./use-chat-stream";

function isAccessDenied(error: unknown): boolean {
  return (
    (error instanceof ModuleApiError || error instanceof ApiError) &&
    [401, 403, 404].includes(error.status)
  );
}

/** Check access before mounting history; transient refresh failures keep the open chat. */
export function MeetingChatDrawer(props: {
  readonly selection: MeetingChatSelection & { readonly title: string };
  readonly onClose: () => void;
  readonly onRemoveContext?: () => void;
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
    enabled: !unavailable,
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
    refetchOnWindowFocus: "always"
  });
  const title = useQuery({
    queryKey: ["meeting-chat-title", selection.meetingId, selection.selectionId],
    queryFn: async ({ signal }) => {
      // Keep only the title in this selection-bound cache. The record also contains notes,
      // so read it less often than the lightweight access check; title saves invalidate it.
      const { meeting } = await requestJson<{ meeting: MeetingRecord }>(
        `/api/meetings/records/${encodeURIComponent(selection.meetingId)}`,
        { signal }
      );
      return meeting.title;
    },
    enabled: access.data?.available === true && !isAccessDenied(access.error) && !unavailable,
    gcTime: 0,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always"
  });
  const history = useQuery({
    queryKey: ["meeting-chat-history", selection.selectionId],
    queryFn: async () => {
      const { threads } = await listChatThreads(surface);
      return threads[0] ? (await listChatThreadMessages(threads[0].id, surface)).messages : [];
    },
    enabled:
      access.data?.available === true &&
      title.data !== undefined &&
      !isAccessDenied(access.error) &&
      !isAccessDenied(title.error) &&
      !unavailable,
    gcTime: 0,
    retry: false
  });
  const accessDenied =
    isAccessDenied(access.error) || isAccessDenied(title.error) || isAccessDenied(history.error);
  useEffect(() => {
    // Once denied, another failed poll must not reveal previously cached history again.
    if (accessDenied) setUnavailable(true);
  }, [accessDenied]);
  const denied = accessDenied || unavailable;
  if (
    denied ||
    access.data?.available !== true ||
    title.data === undefined ||
    history.data === undefined
  ) {
    const loadFailed = access.isError || title.isError || history.isError;
    return (
      <aside
        className={`chatd${props.docked ? " chatd--docked" : ""}`}
        role="dialog"
        aria-label="Meeting chat"
      >
        <div className="chatd__head">
          <Chip onRemove={props.onClose}>
            {denied
              ? "Meeting unavailable"
              : loadFailed
                ? "Couldn’t load meeting chat"
                : "Loading meeting…"}
          </Chip>
        </div>
        <p role="status" className="jds-hint">
          {denied
            ? "This meeting is no longer available to this account. Close this conversation and choose an available meeting."
            : loadFailed
              ? "Couldn’t check access or load this conversation. Try again."
              : "Checking access and loading this conversation…"}
        </p>
        {!denied && loadFailed ? (
          <Button
            variant="link"
            disabled={access.isFetching || title.isFetching || history.isFetching}
            onClick={() => {
              if (access.data?.available !== true) void access.refetch();
              else if (title.data === undefined) void title.refetch();
              else void history.refetch();
            }}
          >
            Retry loading meeting chat
          </Button>
        ) : null}
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
      meetingContext={{ ...selection, title: title.data }}
      onRemoveMeetingContext={props.onRemoveContext}
      onMeetingUnavailable={() => setUnavailable(true)}
    />
  );
}
