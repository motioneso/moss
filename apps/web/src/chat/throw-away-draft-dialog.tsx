/**
 * #1890: the confirm step in front of throwing a draft away.
 *
 * Built directly on the shared Dialog/Button pieces rather than reusing the settings screen's
 * `confirm()` helper (apps/web/src/settings/settings-feedback.tsx): that helper reads a React
 * context which only the settings screen mounts, and the draft banner lives on the module's own
 * page. Mounting the settings provider around the whole app to reach one dialog would be a much
 * larger change than #1890 asks for.
 *
 * Wording is deliberately blunt. There is no undo and no earlier version to fall back on, so the
 * dialog says exactly that instead of a generic "are you sure".
 */
import { useId } from "react";

import { Button, Dialog } from "@moss/ui";

export interface ThrowAwayDraftDialogProps {
  readonly moduleId: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** True while the delete is in flight; both buttons lock so it cannot be fired twice. */
  readonly busy?: boolean;
}

export function ThrowAwayDraftDialog(props: ThrowAwayDraftDialogProps) {
  const titleId = useId();
  return (
    <Dialog
      title={<span id={titleId}>Throw this draft away?</span>}
      description="This deletes the draft and everything in it."
      aria-labelledby={titleId}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={props.onCancel} disabled={props.busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={props.onConfirm} disabled={props.busy}>
            {props.busy ? "Throwing away..." : "Throw it away"}
          </Button>
        </>
      }
    >
      <p className="jds-card__meta" data-module-id={props.moduleId}>
        There is no undo, and no earlier version to go back to. If you want this module again, Moss
        has to build it from scratch.
      </p>
    </Dialog>
  );
}
