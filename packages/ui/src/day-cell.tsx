import { type ReactNode } from "react";

export interface DayCellProps {
  readonly out?: boolean;
  readonly today?: boolean;
  /** Without it the date is plain text rather than a button. */
  readonly onPickDate?: () => void;
  readonly dateContent: ReactNode;
  readonly children?: ReactNode;
}

export function DayCell(props: DayCellProps) {
  const classes = ["cal-mcell", props.out ? "is-out" : null, props.today ? "is-today" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      {props.onPickDate ? (
        <button type="button" className="cal-mcell__date" onClick={props.onPickDate}>
          {props.dateContent}
        </button>
      ) : (
        <span className="cal-mcell__date">{props.dateContent}</span>
      )}
      <div className="cal-mcell__evs">{props.children}</div>
    </div>
  );
}
