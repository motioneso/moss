import { type ReactNode } from "react";

export interface RowIndexProps {
  readonly children: ReactNode;

  /** Compact rows sit inside a section block: body-size title, tighter padding, no trailing gap. */
  readonly density?: "default" | "compact";
}

export function RowIndex(props: RowIndexProps) {
  const className = props.density === "compact" ? "jds-index jds-index--compact" : "jds-index";
  return <div className={className}>{props.children}</div>;
}

export interface RowIndexItemProps {
  readonly title: ReactNode;
  readonly excerpt?: ReactNode;
  readonly meta?: ReactNode;
}

export function RowIndexItem(props: RowIndexItemProps) {
  return (
    <div className="jds-index__row">
      <div className="jds-index__title">{props.title}</div>
      {props.excerpt ? <div className="jds-index__excerpt">{props.excerpt}</div> : null}
      {props.meta ? <div className="jds-index__meta">{props.meta}</div> : null}
    </div>
  );
}
