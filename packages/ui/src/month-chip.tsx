import { type CSSProperties, type ReactNode } from "react";

export interface MonthChipProps {
  readonly block?: boolean;
  readonly color: string;
  readonly time?: ReactNode;
  readonly title: ReactNode;
  /** Trailing value, such as an amount, kept whole while the title truncates. */
  readonly aside?: ReactNode;
  /** Accessible name and hover text when the visible parts do not say everything. */
  readonly label?: string;
  /** Settled entries recede. */
  readonly muted?: boolean;
  /** Cancelled entries keep their place with the title struck through. */
  readonly struck?: boolean;
  readonly onClick?: () => void;
}

export function MonthChip(props: MonthChipProps) {
  const classes = [
    "cal-mchip",
    props.block ? "is-block" : null,
    props.muted ? "is-muted" : null,
    props.struck ? "is-struck" : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={{ "--ev": props.color } as CSSProperties}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <span className="cal-mchip__dot" />
      {props.time ? <span className="cal-mchip__t">{props.time}</span> : null}
      <span className="cal-mchip__title">{props.title}</span>
      {props.aside ? <span className="cal-mchip__aside">{props.aside}</span> : null}
    </button>
  );
}
