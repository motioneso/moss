import {
  ChartGrid,
  ChartReadout,
  ChartTicks,
  niceTicks,
  percentScale,
  readoutText,
  useActiveIndex
} from "./chart-parts.js";

export interface TrendPoint {
  /* Position along the time axis, such as a timestamp. Points arrive in ascending order. */
  readonly at: number;
  readonly value: number;
  /* Name for the readout, such as "October 5". */
  readonly name: string;
}

export interface TrendChartProps {
  /* Accessible name of the plot. The section head names the series, so there is no legend. */
  readonly label: string;
  readonly points: readonly TrendPoint[];
  readonly format: (value: number) => string;
  /* Shorter values for the axis. Defaults to format. */
  readonly formatTick?: (value: number) => string;
  /* Axis labels under the first and last point. */
  readonly startLabel?: string;
  readonly endLabel?: string;
  readonly className?: string;
}

/* Keeps zero on the axis unless the values sit far from it, so a small change over a large
   balance still reads. */
function domain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const nearZero = lo >= 0 ? lo <= hi / 2 : hi <= 0 ? hi >= lo / 2 : true;
  return nearZero ? [Math.min(lo, 0), Math.max(hi, 0)] : [lo, hi];
}

function nearest(fractions: readonly number[], fraction: number): number {
  let lo = 0;
  let hi = fractions.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((fractions[mid] ?? 0) < fraction) lo = mid;
    else hi = mid;
  }
  return Math.abs((fractions[hi] ?? 0) - fraction) < Math.abs((fractions[lo] ?? 0) - fraction)
    ? hi
    : lo;
}

/* One 2px line over a light area, spaced by time. Hover snaps a crosshair to the nearest point;
   focus and arrow keys step through the points. */
export function TrendChart(props: TrendChartProps) {
  const points = props.points;
  const [lo, hi] = domain(points.map((point) => point.value));
  const ticks = niceTicks(lo, hi);
  const y = percentScale(ticks);
  const first = points[0]?.at ?? 0;
  const span = (points[points.length - 1]?.at ?? first) - first || 1;
  const fractions = points.map((point) => (point.at - first) / span);
  const { active, handlers } = useActiveIndex(points.length, (fraction) =>
    nearest(fractions, fraction)
  );

  const coords = points.map(
    (point, index) =>
      `${((fractions[index] ?? 0) * 100).toFixed(3)},${(100 - y(point.value)).toFixed(3)}`
  );
  const base = (
    100 - y(Math.min(Math.max(0, ticks[0] ?? 0), ticks[ticks.length - 1] ?? 0))
  ).toFixed(3);
  const line = `M${coords.join("L")}`;
  const area = `${line}L100,${base}L0,${base}Z`;

  const last = points.length - 1;
  const shown = active ?? last;
  const point = points[shown];
  const x = (fractions[shown] ?? 0) * 100;
  const rows =
    active === null || !point
      ? []
      : [
          {
            key: "value",
            label: props.label,
            value: props.format(point.value),
            tone: "jds-chart__tone--accent"
          }
        ];

  return (
    <figure className={["jds-chart", props.className ?? null].filter(Boolean).join(" ")}>
      <div className="jds-chart__frame">
        <ChartTicks ticks={ticks} y={y} format={props.formatTick ?? props.format} />
        <div
          className="jds-chart__plot jds-chart__tone--accent"
          role="group"
          aria-label={props.label}
          tabIndex={points.length > 0 ? 0 : -1}
          {...handlers}
        >
          <ChartGrid ticks={ticks} y={y} />
          {points.length > 1 ? (
            <svg
              className="jds-chart__svg"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path className="jds-chart__area" d={area} />
              <path className="jds-chart__line" d={line} vectorEffect="non-scaling-stroke" />
            </svg>
          ) : null}
          {active !== null ? <span className="jds-chart__cross" style={{ left: `${x}%` }} /> : null}
          {point ? (
            <span
              className="jds-chart__dot"
              style={{ left: `${x}%`, bottom: `${y(point.value)}%` }}
            />
          ) : null}
          {active !== null && point ? <ChartReadout at={x} title={point.name} rows={rows} /> : null}
        </div>
        {props.startLabel || props.endLabel ? (
          <div className="jds-chart__x jds-chart__x--ends" aria-hidden="true">
            <span>{props.startLabel}</span>
            <span>{props.endLabel}</span>
          </div>
        ) : null}
      </div>
      <span className="jds-sr-only" aria-live="polite">
        {active === null || !point ? "" : readoutText(point.name, rows)}
      </span>
    </figure>
  );
}
