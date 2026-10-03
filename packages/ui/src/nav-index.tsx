import { type ReactNode } from "react";

export interface NavIndexProps {
  /** Accessible name of the navigation region. */
  readonly ariaLabel: string;
  /** Visible eyebrow above the rows. */
  readonly label?: ReactNode;
  readonly children: ReactNode;
  /** Content under the rows, such as a secondary menu. */
  readonly footer?: ReactNode;
}

/** A quiet vertical index of selectable rows, ruled like Today's row index. */
export function NavIndex(props: NavIndexProps) {
  return (
    <nav className="jds-navindex" aria-label={props.ariaLabel}>
      {props.label ? <p className="jds-navindex__label">{props.label}</p> : null}
      <ul className="jds-navindex__list">{props.children}</ul>
      {props.footer ? <div className="jds-navindex__foot">{props.footer}</div> : null}
    </nav>
  );
}

export interface NavIndexItemProps {
  readonly label: ReactNode;
  readonly count?: ReactNode;
  readonly selected?: boolean;
  /** Full accessible name when the visible label is shortened or needs context. */
  readonly ariaLabel?: string;
  readonly onSelect: () => void;
}

export function NavIndexItem(props: NavIndexItemProps) {
  return (
    <li className="jds-navindex__row">
      <button
        type="button"
        className="jds-navindex__item"
        aria-pressed={props.selected ?? false}
        aria-label={props.ariaLabel}
        onClick={props.onSelect}
      >
        <span className="jds-navindex__name">{props.label}</span>
        {props.count !== undefined ? (
          <span className="jds-navindex__count">{props.count}</span>
        ) : null}
      </button>
    </li>
  );
}
