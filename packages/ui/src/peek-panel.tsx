import { useRef, type ReactNode, type RefObject } from "react";
import { useDialogLifecycle } from "./use-dialog-lifecycle.js";

export interface PeekPanelBaseProps {
  readonly modal?: boolean;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly dismissOnEscape?: boolean;
}

export type PeekPanelProps = PeekPanelBaseProps &
  (
    | { readonly modal: true; readonly onClose: () => void }
    | { readonly modal?: false; readonly onClose?: () => void }
  );

/** Nonmodal by default. Modal mode owns its scrim, focus containment and dismissal. */
export function PeekPanel(props: PeekPanelProps) {
  const ref = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogLifecycle({
    ...props,
    ref,
    backdropRef,
    modal: props.modal ?? false,
    enabled: props.modal === true
  });
  return (
    <>
      {props.modal ? (
        <div
          ref={backdropRef}
          className="cal-peek-scrim"
          onClick={props.onClose}
          aria-hidden="true"
        />
      ) : null}
      <aside
        className="cal-peek"
        role="dialog"
        ref={ref}
        tabIndex={props.modal ? -1 : undefined}
        aria-modal={props.modal || undefined}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        onKeyDown={onKeyDown}
      >
        {props.children}
      </aside>
    </>
  );
}
