import { X } from "lucide-react";
import { IconButton } from "./icon-button.js";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { useDialogLifecycle } from "./use-dialog-lifecycle.js";

export interface DialogProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly "aria-labelledby"?: string;
  /** Extra class on the dialog surface, for a section to scope layout-only overrides (size, scroll). */
  readonly className?: string;
  /** Safe default: focus the dialog surface, never an arbitrary destructive action. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly dismissOnEscape?: boolean;
  readonly dismissOnBackdrop?: boolean;
  /** Supplying a label adds a shared close control to the heading. */
  readonly closeLabel?: string;
  readonly closeDisabled?: boolean;
}

export function Dialog(props: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogLifecycle({ ...props, ref });
  return (
    <div
      className="jds-dialog-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget && props.dismissOnBackdrop !== false)
          props.onClose();
      }}
    >
      <div
        className={props.className ? `jds-dialog ${props.className}` : "jds-dialog"}
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props["aria-labelledby"] ?? titleId}
        aria-describedby={props.description ? descriptionId : undefined}
      >
        <div className="jds-dialog__head">
          <div className="jds-dialog__heading">
            <div className="jds-dialog__title" id={titleId}>
              {props.title}
            </div>
            {props.closeLabel ? (
              <IconButton
                aria-label={props.closeLabel}
                disabled={props.closeDisabled}
                onClick={props.onClose}
              >
                <X size={18} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
          {props.description ? (
            <div className="jds-dialog__desc" id={descriptionId}>
              {props.description}
            </div>
          ) : null}
        </div>
        <div className="jds-dialog__body">{props.children}</div>
        {props.footer ? <div className="jds-dialog__foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}
