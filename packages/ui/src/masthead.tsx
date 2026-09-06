import { type ReactNode } from "react";

export type MastheadTone = "default" | "field";

export interface MastheadProps {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly accent?: ReactNode;
  readonly lede?: ReactNode;
  readonly aside?: ReactNode;
  readonly tone?: MastheadTone;
}

export function Masthead(props: MastheadProps) {
  const { tone = "default" } = props;
  const classes = ["jds-masthead", tone === "field" ? "jds-masthead--field" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <header className={classes}>
      <div className="jds-masthead__row">
        <div className="jds-masthead__main">
          {props.eyebrow ? <p className="jds-masthead__eyebrow">{props.eyebrow}</p> : null}
          <h1 className="jds-masthead__title">
            <span>{props.title}</span>
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
