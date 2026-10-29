import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, useMeetingChat, clearSessionUnsavedChanges } from "@moss/module-web-sdk";
import { Button, Dialog } from "@moss/ui";
import type { MeetingRecord } from "@moss/shared";
import { deleteMeeting, meetingKeys } from "./client.js";
import { forgetHistoryItem, historyKeys } from "./history-client.js";

export function DeleteMeetingDialog({
  meeting,
  onClose,
  onDeleted
}: {
  readonly meeting: MeetingRecord;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const client = useQueryClient();
  const { clearMeetingChat } = useMeetingChat();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const cancel = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: () => deleteMeeting(meeting.id),
    onSuccess: async () => {
      // Stop older result pages before pruning, so a delayed read cannot restore the row.
      await client.cancelQueries({ queryKey: historyKeys.lists });
      forgetHistoryItem(client, meeting.id);
      client.removeQueries({ queryKey: historyKeys.item(meeting.id), exact: true });
      clearMeetingChat(meeting.id);
      clearSessionUnsavedChanges(client, `meetings:${meeting.id}:`);
      client.removeQueries({ queryKey: meetingKeys.record(meeting.id), exact: true });
      client.removeQueries({ queryKey: meetingKeys.editor(meeting.id), exact: true });
      client.removeQueries({ queryKey: ["meetings", "title", meeting.id], exact: true });
      client.removeQueries({ queryKey: ["meetings", "output-session", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "outputs", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "exports", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "output-artifact", meeting.id] });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      if (active.current) onDeleted();
    }
  });
  const cleanupCode = mutation.error instanceof ApiError ? mutation.error.code : null;
  const errorMessage =
    cleanupCode === "meeting_cleanup_pending"
      ? "Recording cleanup is pending or a notes folder is unavailable. Restore folder access if needed, then retry deletion. The recording is still here."
      : cleanupCode === "meeting_cleanup_conflict"
        ? "A note from this recording changed. Review its current contribution and preserve unrelated text before retrying deletion. The recording is still here."
        : "Couldn’t confirm deletion. You can retry or cancel without losing your edits here.";
  return (
    <Dialog
      initialFocusRef={cancel}
      dismissOnEscape={!mutation.isPending}
      dismissOnBackdrop={!mutation.isPending}
      className="meetings-dialog"
      title={<span id="meeting-delete-title">Delete this meeting?</span>}
      aria-labelledby="meeting-delete-title"
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      footer={
        <>
          <Button ref={cancel} variant="secondary" disabled={mutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Deleting…" : "Permanently delete meeting"}
          </Button>
        </>
      }
    >
      <p>
        “{meeting.title}”, its personal notes, transcript revisions, generated versions, and meeting
        chat will be permanently deleted. This cannot be undone. Unsaved edits will be lost. Exact
        source-linked note contributions and unsupported recording memories are removed first.
        Accepted Tasks and independent saved vault copies remain.
      </p>
      {mutation.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {errorMessage}
        </p>
      ) : null}
    </Dialog>
  );
}
