import { useEffect, useRef } from "react";
import { Button, Dialog } from "@moss/ui";

export function SignOutConfirmation({
  onCancel,
  onConfirm
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== "Tab") return;
      if (event.shiftKey && document.activeElement === cancel.current) {
        event.preventDefault();
        confirm.current?.focus();
      } else if (!event.shiftKey && document.activeElement === confirm.current) {
        event.preventDefault();
        cancel.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onCancel]);
  return (
    <Dialog
      title={<span id="sign-out-confirm-title">Sign out with unsaved changes?</span>}
      aria-labelledby="sign-out-confirm-title"
      onClose={onCancel}
      footer={
        <>
          <Button ref={cancel} variant="secondary" onClick={onCancel}>
            Keep editing
          </Button>
          <Button ref={confirm} variant="danger" onClick={onConfirm}>
            Discard changes and sign out
          </Button>
        </>
      }
    >
      <p>Your unsaved edits will be lost. A save that is already in progress may still finish.</p>
    </Dialog>
  );
}
