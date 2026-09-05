import { Info } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { IconButton } from "./icon-button.js";

export interface InfoTipProps {
  readonly label: string;
  readonly children: ReactNode;
}

function isOutsideTarget(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (!container) return true;
  const node = target as { readonly nodeType?: unknown } | null;
  if (!node || typeof node.nodeType !== "number") return true;
  return !container.contains(target as unknown as Node);
}

/** A small info icon that opens a plain-text explanation panel on click. */
export function InfoTip(props: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isOutsideTarget(ref.current, event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="jds-infotip" ref={ref}>
      <IconButton
        ref={triggerRef}
        size="sm"
        active={open}
        aria-label={props.label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Info size={15} aria-hidden="true" />
      </IconButton>
      {open ? (
        <div className="jds-menu__list jds-infotip__panel" role="tooltip">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
