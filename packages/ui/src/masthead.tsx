import { type ReactNode } from "react";

export type MastheadTone = "default" | "field";

export interface MastheadProps {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly accent?: ReactNode;
  /** Decorative mark set flush after the title, such as a gold full stop. */
  readonly mark?: ReactNode;
  readonly lede?: ReactNode;
  readonly aside?: ReactNode;
  readonly tone?: MastheadTone;
  readonly compact?: boolean;
}

export function Masthead(props: MastheadProps) {
  const { tone = "default" } = props;
  const classes = [
    "jds-masthead",
    tone === "field" ? "jds-masthead--field" : null,
    props.compact ? "jds-masthead--compact" : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <header className={classes}>
      <div className="jds-masthead__row">
        <div className="jds-masthead__main">
          {props.eyebrow ? <p className="jds-masthead__eyebrow">{props.eyebrow}</p> : null}
          <h1 className="jds-masthead__title">
            <span>{props.title}</span>
            {props.mark ? (
              <span className="jds-masthead__mark" aria-hidden="true">
                {props.mark}
              </span>
            ) : null}
            {props.accent ? (
              <>
                {" "}
                <span className="jds-masthead__accent">{props.accent}</span>
              </>
            ) : null}
          </h1>
          {props.lede ? <p className="jds-masthead__lede">{props.lede}</p> : null}
        </div>
        {props.aside ? <div className="jds-masthead__aside">{props.aside}</div> : null}
      </div>
    </header>
  );
}

export interface MastheadDatelineProps {
  readonly children: ReactNode;
}

export function MastheadDateline(props: MastheadDatelineProps) {
  return <div className="jds-masthead__dateline">{props.children}</div>;
}

export interface MastheadFigureItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
}

export interface MastheadFiguresProps {
  /* Accessible name of the list, such as "Assets and debts". */
  readonly label: string;
  readonly items: readonly MastheadFigureItem[];
}

/* Labelled figures for a masthead aside, such as the parts of the total in the title. */
export function MastheadFigures(props: MastheadFiguresProps) {
  return (
    <dl className="jds-masthead__figures" aria-label={props.label}>
      {props.items.map((item, index) => (
        <div key={index} className="jds-masthead__figure">
          <dt className="jds-masthead__figure-label">{item.label}</dt>
          <dd className="jds-masthead__figure-value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface MastheadClockProps {
  readonly time: ReactNode;
  readonly pm?: boolean;
}

export function MastheadClock(props: MastheadClockProps) {
  return (
    <div className="jds-masthead__clock" aria-hidden="true">
      <span className="jds-masthead__clock-time">
        {props.pm ? <span className="jds-masthead__clock-pm" title="PM" /> : null}
        {props.time}
      </span>
    </div>
  );
}
