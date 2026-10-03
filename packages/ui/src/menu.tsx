import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  /** Overrides the accessible name when the visible label is shorter than what a screen reader needs. */
  readonly ariaLabel?: string;
  /** When set, the item is a toggle and reports this state to assistive tech. */
  readonly checked?: boolean;
}

export interface MenuProps {
  readonly triggerIcon: ReactNode;
  readonly triggerLabel: string;
  readonly items: readonly MenuItem[];
  readonly onSelect: (id: string) => void;
}

function isOutsideTarget(container: HTMLElement, target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return true;
  if (!("nodeType" in target)) return true;
  return !container.contains(target as Node);
}

export function Menu(props: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;

    function onPointerDown(event: PointerEvent) {
      if (container && isOutsideTarget(container, event.target)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="jds-menu" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="jds-menu__trigger"
        aria-label={props.triggerLabel}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {props.triggerIcon}
      </button>
      {open ? (
        <div className="jds-menu__list" role="menu">
          {props.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              aria-label={item.ariaLabel}
              disabled={item.disabled}
              onClick={() => {
                close();
                props.onSelect(item.id);
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
