import { useEffect, useRef } from "react";
import { Button, Dialog } from "@moss/ui";

export function MeetingUnlinkDialog({
  name,
  pending,
  allowed,
  error,
  onClose,
  onConfirm
}: {
  readonly name: string;
  readonly pending: boolean;
  readonly allowed: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const buttons = cancel.current
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const first = buttons?.[0],
        last = buttons?.[buttons.length - 1];
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
  }, [onClose, pending]);
  return (
    <Dialog
      title={<span id="meeting-unlink-title">Unlink {name}?</span>}
      aria-labelledby="meeting-unlink-title"
      onClose={() => {
        if (!pending) onClose();
      }}
      footer={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending || !allowed} onClick={onConfirm}>
            {pending ? "Unlinking…" : "Unlink Mac"}
          </Button>
        </>
      }
    >
      <p>
        This signs Trail Marker out of your account and stops its meeting recording. Focus and
        Backtrack also lose this connection. You’ll need to link this Mac again to use it with Moss.
        Your saved notes and transcripts stay available.
      </p>
      {!allowed && !pending ? (
        <p role="status" className="jds-hint">
          This Mac’s link could not be verified. Cancel and check again.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="jds-hint jds-hint--error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
