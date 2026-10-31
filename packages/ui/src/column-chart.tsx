import {
  ChartGrid,
  ChartReadout,
  ChartTicks,
  niceTicks,
  percentScale,
  readoutText,
  SERIES_TONES,
  useActiveIndex,
  type ReadoutRow
} from "./chart-parts.js";

export interface ColumnChartSeries {
  readonly key: string;
  readonly label: string;
  /* One value per category. */
  readonly values: readonly number[];
  /* Shown after the legend label, such as the total for the period. */
  readonly total?: string;
}

export interface ColumnChartMarker {
  readonly label: string;
  readonly values: readonly number[];
  readonly total?: string;
}

export interface ColumnChartProps {
  /* Accessible name of the plot. */
  readonly label: string;
  /* Short axis labels, one per column group, such as "Oct". */
  readonly categories: readonly string[];
  /* Full names for the readout, such as "October 2026". Defaults to the axis labels. */
  readonly categoryNames?: readonly string[];
  /* Series take the chart colours in order, so pass every series even when it is empty. */
  readonly series: readonly [ColumnChartSeries] | readonly [ColumnChartSeries, ColumnChartSeries];
  /* An ink dot in each group, such as net cash flow. */
  readonly marker?: ColumnChartMarker;
  readonly format: (value: number) => string;
  /* Shorter values for the axis. Defaults to format. */
  readonly formatTick?: (value: number) => string;
  readonly className?: string;
}

/* Grouped columns from a zero baseline. Hover, focus and arrow keys show one group's values.
   The chart enhances a table on the same screen; it never holds the only copy of a number. */
export function ColumnChart(props: ColumnChartProps) {
  const count = props.categories.length;
  const marker = props.marker;
  const values = [...props.series.flatMap((series) => series.values), ...(marker?.values ?? [])];
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const y = percentScale(ticks);
  const { active, handlers } = useActiveIndex(count, (fraction) =>
    Math.min(Math.floor(fraction * count), count - 1)
  );
  const names = props.categoryNames ?? props.categories;
  // On a phone the axis keeps about six labels, always including the latest.
  const step = Math.ceil(count / 6);
  const columns = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` };

  const rows: ReadoutRow[] =
    active === null
      ? []
      : [
          ...props.series.map((series, index) => ({
            key: series.key,
            label: series.label,
            value: props.format(series.values[active] ?? 0),
            tone: SERIES_TONES[index] ?? SERIES_TONES[0]
          })),
          ...(marker
            ? [
                {
                  key: "marker",
                  label: marker.label,
                  value: props.format(marker.values[active] ?? 0),
                  tone: "jds-chart__tone--ink"
                }
              ]
            : [])
        ];
  const title = active === null ? "" : (names[active] ?? "");

  return (
    <figure className={["jds-chart", props.className ?? null].filter(Boolean).join(" ")}>
      <ul className="jds-chart__legend">
        {props.series.map((series, index) => (
          <li key={series.key} className="jds-chart__legend-item">
            <span className={`jds-chart__swatch ${SERIES_TONES[index] ?? SERIES_TONES[0]}`} />
            {series.label}
            {series.total ? <span className="jds-chart__legend-total">{series.total}</span> : null}
          </li>
        ))}
        {marker ? (
          <li className="jds-chart__legend-item">
            <span className="jds-chart__swatch jds-chart__swatch--dot jds-chart__tone--ink" />
            {marker.label}
            {marker.total ? <span className="jds-chart__legend-total">{marker.total}</span> : null}
          </li>
        ) : null}
      </ul>
      <div className="jds-chart__frame">
        <ChartTicks ticks={ticks} y={y} format={props.formatTick ?? props.format} />
        <div
          className="jds-chart__plot"
          role="group"
          aria-label={props.label}
          tabIndex={count > 0 ? 0 : -1}
          {...handlers}
        >
          <ChartGrid ticks={ticks} y={y} />
          <div className="jds-chart__cols" style={columns}>
            {props.categories.map((category, index) => (
              <div
                key={`${index}-${category}`}
                className={active === index ? "jds-chart__col is-active" : "jds-chart__col"}
              >
                {props.series.map((series, slot) => {
                  const value = series.values[index] ?? 0;
                  const top = y(Math.max(value, 0));
                  const bottom = y(Math.min(value, 0));
                  const tone = SERIES_TONES[slot] ?? SERIES_TONES[0];
                  return (
                    <span key={series.key} className="jds-chart__slot">
                      <span
                        className={
                          value < 0
                            ? `jds-chart__bar jds-chart__bar--down ${tone}`
                            : `jds-chart__bar ${tone}`
                        }
                        style={{
                          bottom: `${bottom}%`,
                          height: value === 0 ? 0 : `max(2px, ${top - bottom}%)`
                        }}
                      />
                    </span>
                  );
                })}
                {marker ? (
                  <span
                    className="jds-chart__dot jds-chart__tone--ink"
                    style={{ bottom: `${y(marker.values[index] ?? 0)}%` }}
                  />
                ) : null}
              </div>
            ))}
          </div>
          {active !== null ? (
            <ChartReadout at={((active + 0.5) / count) * 100} title={title} rows={rows} />
          ) : null}
        </div>
        <div className="jds-chart__x" style={columns} aria-hidden="true">
          {props.categories.map((category, index) => (
            <span
              key={`${index}-${category}`}
              className={(count - 1 - index) % step === 0 ? undefined : "jds-chart__x-minor"}
            >
              {category}
            </span>
          ))}
        </div>
      </div>
      <span className="jds-sr-only" aria-live="polite">
        {active === null ? "" : readoutText(title, rows)}
      </span>
    </figure>
  );
}
