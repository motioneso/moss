import { useDialogLifecycle } from "./use-dialog-lifecycle.js";
import { useCallback, useEffect, useRef, type CSSProperties, type RefObject } from "react";

export interface ColorPopoverProps {
  /** Field name shown at the top, also the dialog's accessible name. */
  readonly title: string;
  /** Current color as #rrggbb. */
  readonly value: string;
  /** Colors the user pasted; shown as a row of swatches above the free picker. */
  readonly palette: readonly string[];
  /** A palette swatch was chosen. The caller closes the popover. */
  readonly onPick: (color: string) => void;
  /** The free picker moved. The popover stays open. */
  readonly onInput: (color: string) => void;
  readonly onClose: () => void;
  /** Pointer presses inside this element do not count as outside clicks. */
  readonly anchorRef?: RefObject<HTMLElement | null>;
  readonly emptyHint?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const EDGE_GAP = 8;

/* The picker panel: pasted palette on top, any color below. Escape or an
   outside press closes it. Callers position it. */
export function ColorPopover(props: ColorPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  const { anchorRef } = props;
  const value = props.value.toLowerCase();
  const onKeyDown = useDialogLifecycle({
    ref,
    modal: false,
    onClose: props.onClose,
    returnFocusRef: anchorRef
  });

  useEffect(() => {
    closeRef.current = props.onClose;
  });

  /* Slide sideways to stay inside the window when the anchor sits near an edge.
     A ref callback measures before paint; it reruns when the caller moves the panel. */
  const left = props.style?.left;
  const top = props.style?.top;
  const place = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      if (!el) return;
      el.style.translate = "";
      const rect = el.getBoundingClientRect();
      const overRight = rect.right - (window.innerWidth - EDGE_GAP);
      const dx = rect.left < EDGE_GAP ? EDGE_GAP - rect.left : overRight > 0 ? -overRight : 0;
      if (dx) el.style.translate = `${dx}px 0`;
    },
    [left, top]
  );

  useEffect(() => {
    const onClose = () => closeRef.current();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [anchorRef]);

  return (
    <div
      ref={place}
      className={["jds-colorpop", props.className].filter(Boolean).join(" ")}
      style={props.style}
      role="dialog"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={`${props.title} color`}
    >
      <div className="jds-colorpop__head">
        <span className="jds-colorpop__title">{props.title}</span>
        <span className="jds-colorpop__value">{value}</span>
      </div>
      <div className="jds-colorpop__label">From your palette</div>
      {props.palette.length ? (
        <div className="jds-colorpop__row">
          {props.palette.map((color) => (
            <button
              key={color}
              type="button"
              className="jds-swatch jds-colorpop__swatch"
              style={{ "--jds-swatch": color } as CSSProperties}
              aria-label={`Use ${color}`}
              aria-pressed={color.toLowerCase() === value}
              onClick={() => props.onPick(color)}
            />
          ))}
        </div>
      ) : (
        <p className="jds-colorpop__empty">
          {props.emptyHint ?? "Paste a palette and its colors show here."}
        </p>
      )}
      <label className="jds-colorpop__label">
        Any color
        <input
          type="color"
          className="jds-colorbox jds-colorpop__any"
          value={/^#[0-9a-f]{6}$/.test(value) ? value : "#000000"}
          onChange={(event) => props.onInput(event.target.value)}
        />
      </label>
    </div>
  );
}

export interface ColorBoxProps {
  /** Field name; labels the button and titles the popover. */
  readonly label: string;
  /** Current color as #rrggbb. */
  readonly value: string;
  readonly palette: readonly string[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChange: (color: string) => void;
  /** Draws a rule at this weight instead of a flat fill, for line colors. */
  readonly rule?: string;
}

/* A solid color box that opens the picker under itself. */
export function ColorBox(props: ColorBoxProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="jds-colorbox-wrap">
      <button
        ref={anchorRef}
        type="button"
        className={props.rule ? "jds-colorbox jds-colorbox--rule" : "jds-colorbox"}
        style={
          props.rule
            ? ({
                "--colorbox-rule-color": props.value,
                "--colorbox-rule-weight": props.rule
              } as CSSProperties)
            : ({ "--jds-colorbox": props.value } as CSSProperties)
        }
        aria-label={`${props.label} color`}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        {props.rule ? <i aria-hidden="true" /> : null}
      </button>
      {props.open ? (
        <ColorPopover
          className="jds-colorpop--under"
          title={props.label}
          value={props.value}
          palette={props.palette}
          anchorRef={anchorRef}
          onClose={() => props.onOpenChange(false)}
          onPick={(color) => {
            props.onChange(color);
            props.onOpenChange(false);
          }}
          onInput={props.onChange}
        />
      ) : null}
    </span>
  );
}
