import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

import { nextFocusTrapIndex, restorePaletteFocus } from "../shell/command-palette.js";

export interface BriefingDialogProps {
  readonly title: string;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly footer: ReactNode;
  readonly children: ReactNode;
  /** Report chrome: an eyebrow line inside the head before the title. */
  readonly eyebrow?: string;
  /** Report chrome: a tab strip or toolbar rendered after the head. */
  readonly nav?: ReactNode;
  /** Adds the report surface class; absent leaves the plain dialog unchanged. */
  readonly variant?: "report";
}

/**
 * Focused briefing shell: the report reads as one dialog on every width, with
 * the palette's focus contract (title focus on open, trapped Tab, Escape and
 * close return focus to the opener). Rendered in a portal so the app root can
 * go inert behind it. T18 will mount the review tab inside unchanged.
 */
export function BriefingDialog(props: BriefingDialogProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(props.opener);
  openerRef.current = props.opener;

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-briefing-title]")?.focus();
    const appRoot = document.getElementById("root");
    appRoot?.setAttribute("inert", "");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      appRoot?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
      restorePaletteFocus(openerRef.current);
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event, rootRef.current);
    }
  }

  return createPortal(
    <div className="brief-reader__scrim" onKeyDown={onKeyDown}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={
          props.variant === "report" ? "brief-reader brief-reader--report" : "brief-reader"
        }
      >
        <div className="brief-reader__head">
          {props.eyebrow === undefined ? null : (
            <p className="brief-reader__eyebrow">{props.eyebrow}</p>
          )}
          <h2 id={titleId} data-briefing-title tabIndex={-1} className="brief-reader__title">
            {props.title}
          </h2>
          <button
            type="button"
            className="jds-btn jds-btn--sm jds-btn--quiet"
            onClick={props.onClose}
            aria-label="Close briefing reader"
          >
            Close
          </button>
        </div>
        {props.nav}
        <div className="brief-reader__body">{props.children}</div>
        <div className="brief-reader__footer">{props.footer}</div>
      </div>
    </div>,
    document.body
  );
}

function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (!root) return;
  const nodes = focusableElements(root);
  if (nodes.length === 0) {
    event.preventDefault();
    return;
  }
  const currentIndex = nodes.findIndex((node) => node === document.activeElement);
  const nextIndex = nextFocusTrapIndex(currentIndex, nodes.length, event.shiftKey);
  if (nextIndex === null) return;
  event.preventDefault();
  nodes[nextIndex]?.focus();
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ].filter((node) => !node.hasAttribute("disabled") && node.tabIndex !== -1);
}
