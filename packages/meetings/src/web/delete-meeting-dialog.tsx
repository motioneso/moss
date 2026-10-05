import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMeetingChat, clearSessionUnsavedChanges } from "@moss/module-web-sdk";
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
      client.removeQueries({ queryKey: ["meetings", "output-session", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "outputs", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "exports", meeting.id] });
      client.removeQueries({ queryKey: ["meetings", "output-artifact", meeting.id] });
      void client.invalidateQueries({ queryKey: meetingKeys.history });
      if (active.current) onDeleted();
    }
  });
  useEffect(() => {
    const previous = typeof document === "undefined" ? null : document.activeElement;
    cancel.current?.focus();
    return () => {
      if (typeof HTMLElement !== "undefined" && previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !mutation.isPending) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const buttons = cancel.current
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [mutation.isPending, onClose]);
  return (
    <Dialog
      className="meetings-dialog"
      title={<span id="meeting-delete-title">Delete this draft?</span>}
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
            {mutation.isPending ? "Deleting…" : "Permanently delete draft"}
          </Button>
        </>
      }
    >
      <p>
        “{meeting.title}”, its personal notes, transcript revisions, generated versions, and meeting
        chat will be permanently deleted. This cannot be undone. Unsaved edits will be lost.
        Accepted Tasks and saved vault copies remain.
      </p>
      {mutation.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t confirm deletion. You can retry or cancel without losing your edits here.
        </p>
      ) : null}
    </Dialog>
  );
}
