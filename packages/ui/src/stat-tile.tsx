import { ArrowUpRight } from "lucide-react";
import { type ReactNode } from "react";

export interface StatTileProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly icon?: ReactNode;
  readonly warn?: boolean;
  /** A fact line under the value. */
  readonly sub?: ReactNode;
  /** Without it the tile is a plain block, not a button. */
  readonly onClick?: () => void;
}

export function StatTile(props: StatTileProps) {
  const classes = [
    "jds-stat-tile",
    props.warn ? "jds-stat-tile--warn" : null,
    props.onClick ? null : "jds-stat-tile--static"
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <div className="jds-stat-tile__label">
        {props.icon}
        {props.label}
        {props.onClick ? (
          <span className="jds-stat-tile__go">
            <ArrowUpRight size={13} aria-hidden="true" />
          </span>
        ) : null}
      </div>
      <div className="jds-stat-tile__value">{props.value}</div>
      {props.sub ? <div className="jds-stat-tile__sub">{props.sub}</div> : null}
    </>
  );
  return props.onClick ? (
    <button type="button" className={classes} onClick={props.onClick}>
      {body}
    </button>
  ) : (
    <div className={classes}>{body}</div>
  );
}
