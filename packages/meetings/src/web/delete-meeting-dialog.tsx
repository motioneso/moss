import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog } from "@moss/ui";
import type { MeetingRecord } from "@moss/shared";
import { deleteMeeting, meetingKeys } from "./client.js";

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
    onSuccess: () => {
      client.removeQueries({ queryKey: meetingKeys.record(meeting.id), exact: true });
      client.removeQueries({ queryKey: meetingKeys.editor(meeting.id), exact: true });
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
        “{meeting.title}” and its personal notes will be permanently deleted. This cannot be undone.
        Any unsaved edits will also be lost.
      </p>
      {mutation.isError ? (
        <p role="alert" className="jds-hint jds-hint--error">
          Couldn’t confirm deletion. You can retry or cancel without losing your edits here.
        </p>
      ) : null}
    </Dialog>
  );
}
