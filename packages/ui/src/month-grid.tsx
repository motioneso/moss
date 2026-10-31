import { type ReactNode } from "react";

export interface MonthGridProps {
  /** Seven column labels, in the order the cells run. */
  readonly weekdays: readonly string[];
  readonly label: string;
  /** DayCell elements, seven per week. */
  readonly children: ReactNode;
}

/* A month grid that sits in page flow: rows grow with their entries instead of filling the
   viewport. The column labels are hidden from screen readers, so entries name their own date. */
export function MonthGrid(props: MonthGridProps) {
  return (
    <div className="cal-month cal-month--fit" role="group" aria-label={props.label}>
      <div className="cal-month__head" aria-hidden="true">
        {props.weekdays.map((day, index) => (
          <div key={index} className="cal-month__dow">
            {day}
          </div>
        ))}
      </div>
      <div className="cal-month__grid">{props.children}</div>
    </div>
  );
}
