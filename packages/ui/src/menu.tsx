import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

export interface MenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  /** Overrides the accessible name when the visible label is shorter than what a screen reader needs. */
  readonly ariaLabel?: string;
  /** When set, the item is a toggle and reports this state to assistive tech. */
  readonly checked?: boolean;
  /** A muted second line under the label that says what the item does. */
  readonly description?: ReactNode;
}

export interface MenuProps {
  readonly triggerIcon?: ReactNode;
  readonly triggerContent?: ReactNode;
  readonly triggerVariant?: "icon" | "content";
  readonly placement?: "bottom" | "top";
  /** Layout-only wrapper hook. */
  readonly className?: string;
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
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const openAtEnd = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const enabledItems = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // Focus the trigger before native Tab computes the next outside control.
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = enabledItems();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const items = enabledItems();
    (openAtEnd.current ? items.at(-1) : items[0])?.focus();

    function onPointerDown(event: PointerEvent) {
      if (container && isOutsideTarget(container, event.target)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={[
        "jds-menu",
        props.triggerVariant === "content" ? "jds-menu--content" : null,
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        ref={triggerRef}
        className={
          props.triggerVariant === "content"
            ? "jds-menu__trigger jds-menu__trigger--content"
            : "jds-menu__trigger"
        }
        aria-label={props.triggerLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? listId : undefined}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            event.stopPropagation();
            openAtEnd.current = event.key === "ArrowUp";
            setOpen(true);
          }
        }}
        onClick={() => {
          openAtEnd.current = false;
          setOpen(!open);
        }}
      >
        {props.triggerContent ?? props.triggerIcon}
      </button>
      {open ? (
        <div
          ref={listRef}
          id={listId}
          className={
            props.placement === "top" ? "jds-menu__list jds-menu__list--top" : "jds-menu__list"
          }
          role="menu"
          aria-label={props.triggerLabel}
        >
          {props.items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              aria-label={item.ariaLabel}
              disabled={item.disabled}
              tabIndex={-1}
              onClick={() => {
                close();
                props.onSelect(item.id);
              }}
            >
              {item.icon}
              {item.description === undefined ? (
                item.label
              ) : (
                <span className="jds-menu__text">
                  <span>{item.label}</span>
                  <span className="jds-menu__desc">{item.description}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
