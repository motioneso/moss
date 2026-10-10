import { type CSSProperties, type ReactNode } from "react";

export type EventChipVariant = "hard" | "tentative" | "block";

export interface EventChipProps {
  readonly variant: EventChipVariant;
  readonly color: string;
  readonly title: ReactNode;
  readonly holdIcon?: ReactNode;
  readonly time?: ReactNode;
  readonly where?: ReactNode;
  readonly onClick?: () => void;
  readonly style?: CSSProperties;
}

export function EventChip(props: EventChipProps) {
  const classes = ["cal-ev"];
  if (props.variant === "block") classes.push("cal-ev--block", "cal-ev--ghost");
  else if (props.variant === "tentative") classes.push("cal-ev--tentative");
  else classes.push("cal-ev--hard");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={props.onClick}
      style={{ ...props.style, "--ev": props.color } as CSSProperties}
    >
      <span className="cal-ev__bar" />
      <span className="cal-ev__body">
        <span className="cal-ev__title">
          {props.holdIcon ? <span className="cal-ev__hold">{props.holdIcon}</span> : null}
          <span className="cal-ev__titletext">{props.title}</span>
        </span>
        {props.time ? <span className="cal-ev__meta">{props.time}</span> : null}
        {props.where ? <span className="cal-ev__where">{props.where}</span> : null}
      </span>
    </button>
  );
}
