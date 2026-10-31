import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/* Series take these colours in order, the same in every theme. */
export const SERIES_TONES = ["jds-chart__tone--1", "jds-chart__tone--2"] as const;

/* Even steps (1, 2 or 5 times a power of ten) that cover min..max. A flat range is one tick. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const ticks: number[] = [];
  for (let i = Math.floor(min / step); i <= Math.ceil(max / step); i += 1) {
    ticks.push(Number((i * step).toPrecision(12)));
  }
  return ticks;
}

/* Maps a value to its height in percent of the plot. */
export function percentScale(ticks: readonly number[]): (value: number) => number {
  const lo = ticks[0] ?? 0;
  const span = (ticks[ticks.length - 1] ?? lo) - lo || 1;
  return (value) => ((value - lo) / span) * 100;
}

/* Which item the readout shows. Hover follows the pointer; the keyboard and a tap move a focused
   position that holds until the plot loses focus. */
export function useActiveIndex(count: number, pick: (fraction: number) => number) {
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const pointerDown = useRef(false);

  const at = (event: PointerEvent<HTMLElement>): number | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return null;
    return pick(Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1));
  };

  const handlers = {
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (event.pointerType === "mouse") setHover(at(event));
    },
    onPointerLeave() {
      setHover(null);
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      pointerDown.current = true;
      if (event.pointerType !== "mouse") setFocused(at(event));
    },
    onPointerUp() {
      pointerDown.current = false;
    },
    onFocus() {
      if (!pointerDown.current) setFocused((current) => current ?? count - 1);
    },
    onBlur() {
      setFocused(null);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.key === "Escape") {
        setFocused(null);
        return;
      }
      const current = focused ?? count - 1;
      const next =
        event.key === "ArrowRight"
          ? Math.min(current + 1, count - 1)
          : event.key === "ArrowLeft"
            ? Math.max(current - 1, 0)
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? count - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      setHover(null);
      setFocused(next);
    }
  };

  return { active: count > 0 ? (hover ?? focused) : null, handlers };
}

export interface ReadoutRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly tone: string;
}

/* Text for the polite live region, so keyboard users hear what the readout shows. */
export function readoutText(title: string, rows: readonly ReadoutRow[]): string {
  return [title, ...rows.map((row) => `${row.label} ${row.value}`)].join(", ");
}

/* The hover and focus readout. Values lead, labels follow, keyed by a short line in the series
   colour. Screen readers get the same text from the live region instead. */
export function ChartReadout(props: { at: number; title: string; rows: readonly ReadoutRow[] }) {
  const align =
    props.at < 25 ? " jds-chart__tip--start" : props.at > 75 ? " jds-chart__tip--end" : "";
  return (
    <div className={`jds-chart__tip${align}`} style={{ left: `${props.at}%` }} aria-hidden="true">
      <span className="jds-chart__tip-title">{props.title}</span>
      {props.rows.map((row) => (
        <span key={row.key} className="jds-chart__tip-row">
          <span className={`jds-chart__key-line ${row.tone}`} />
          <strong>{row.value}</strong>
          <span>{row.label}</span>
        </span>
      ))}
    </div>
  );
}

/* Value labels beside the gridlines. The hidden copies size the column to the widest label. */
export function ChartTicks(props: {
  ticks: readonly number[];
  y: (value: number) => number;
  format: (value: number) => string;
}) {
  return (
    <div className="jds-chart__ticks" aria-hidden="true">
      {props.ticks.map((tick) => (
        <span key={tick} className="jds-chart__tick" style={{ bottom: `${props.y(tick)}%` }}>
          {props.format(tick)}
        </span>
      ))}
      {props.ticks.map((tick) => (
        <span key={`size-${tick}`} className="jds-chart__tick-size">
          {props.format(tick)}
        </span>
      ))}
    </div>
  );
}

export function ChartGrid(props: { ticks: readonly number[]; y: (value: number) => number }) {
  return props.ticks.map((tick) => (
    <span
      key={tick}
      className={tick === 0 ? "jds-chart__grid jds-chart__grid--zero" : "jds-chart__grid"}
      style={{ bottom: `${props.y(tick)}%` }}
    />
  ));
}
