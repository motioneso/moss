import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Extra text the search box matches against, beyond the label. */
  readonly keywords?: string;
}

export interface ComboboxProps {
  readonly value: string;
  readonly options: readonly ComboboxOption[];
  readonly onChange: (value: string) => void;
  readonly "aria-label": string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly searchPlaceholder?: string;
  readonly emptyText?: string;
}

function isOutside(container: HTMLElement, target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("nodeType" in target)) return true;
  return !container.contains(target as Node);
}

/**
 * A single-select picker with a type-to-filter list, for long option sets where a native select
 * is unworkable (time zones, countries). The trigger reads as a select; the open panel holds a
 * search box and a listbox. Arrow keys move, Enter picks, Escape closes.
 */
export function Combobox(props: ComboboxProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const listId = `${id}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = props.options.find((option) => option.value === props.value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return props.options;
    return props.options.filter((option) =>
      `${option.label} ${option.keywords ?? ""}`.toLowerCase().includes(needle)
    );
  }, [props.options, query]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  };

  const pick = (value: string) => {
    if (value !== props.value) props.onChange(value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const selectedIndex = filtered.findIndex((option) => option.value === props.value);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    searchRef.current?.focus();
    // Only on open: the query effect below keeps `active` in range while typing.
  }, [open]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children.item(active);
    if (item instanceof HTMLElement) item.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isOutside(root, event.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(filtered.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[active];
      if (option) pick(option.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  const activeOption = filtered[active];

  return (
    <div className="jds-combobox" ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className="jds-combobox__trigger"
        role="combobox"
        aria-label={props["aria-label"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={props.disabled}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span
          className={
            selected ? "jds-combobox__value" : "jds-combobox__value jds-combobox__value--empty"
          }
        >
          {selected ? selected.label : (props.placeholder ?? "Select")}
        </span>
        <span className="jds-combobox__chev">
          <ChevronsUpDown size={16} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="jds-combobox__pop">
          <input
            ref={searchRef}
            className="jds-input jds-input--sm jds-combobox__search"
            type="text"
            role="searchbox"
            aria-label={`Search ${props["aria-label"].toLowerCase()}`}
            aria-controls={listId}
            aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
            placeholder={props.searchPlaceholder ?? "Search"}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
          <div
            ref={listRef}
            id={listId}
            className="jds-combobox__list"
            role="listbox"
            aria-label={props["aria-label"]}
          >
            {filtered.length === 0 ? (
              <div className="jds-combobox__empty">{props.emptyText ?? "No matches."}</div>
            ) : (
              filtered.map((option, index) => {
                const isSelected = option.value === props.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    className={
                      index === active
                        ? "jds-combobox__option jds-combobox__option--active"
                        : "jds-combobox__option"
                    }
                    tabIndex={-1}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option.value)}
                  >
                    <span className="jds-combobox__option-label">{option.label}</span>
                    {isSelected ? <Check size={16} aria-hidden="true" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
