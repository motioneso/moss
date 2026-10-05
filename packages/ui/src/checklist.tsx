import { useEffect, useRef } from "react";

import { Button } from "./button.js";

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly checked: boolean;
}

export interface ChecklistProps {
  readonly items: readonly ChecklistItem[];
  readonly onToggle: (id: string) => void;
  readonly onTickAll: () => void;
  readonly onDone: () => void;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
  readonly tickAllLabel?: string;
  readonly doneLabel?: string;
}

/**
 * A tick-one-or-many popup list. Unlike Menu it stays open on each pick so the
 * viewer can tick several rows, then Done. Escape and an outside pointer close it.
 */
export function Checklist(props: ChecklistProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    function onPointerDown(event: PointerEvent) {
      if (!container) return;
      if (event.target instanceof Node && !container.contains(event.target)) {
        props.onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props]);

  return (
    <div className="jds-checklist" role="group" aria-label={props.ariaLabel} ref={ref}>
      {props.items.map((item) => (
        <label className="jds-checklist__item" key={item.id}>
          <input type="checkbox" checked={item.checked} onChange={() => props.onToggle(item.id)} />
          <span className="jds-checklist__label" title={item.label}>
            {item.label}
          </span>
          <span className="jds-checklist__count">{item.count}</span>
        </label>
      ))}
      <div className="jds-checklist__foot">
        <Button variant="quiet" size="sm" onClick={props.onTickAll}>
          {props.tickAllLabel ?? "Tick all"}
        </Button>
        <Button variant="quiet" size="sm" onClick={props.onDone}>
          {props.doneLabel ?? "Done"}
        </Button>
      </div>
    </div>
  );
}
