import { Info, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge as SharedBadge } from "@moss/ui";
export { Switch, Segmented, Avatar, Indicator } from "@moss/ui";
import { Segmented } from "@moss/ui";
export type { GeneratedSettingsSurface } from "./scanner.js";
export * from "./router.js";
export { Select } from "@moss/ui";
export {
  PrioritySettings,
  priorityDraftValidation,
  prioritySourceIncluded,
  priorityWeightLabel
} from "./priority/index.js";

export interface ModuleSettingsSurfaceProps {
  readonly onBack: () => void;
  readonly onSelectSection?: (cat: string) => void;
  readonly onNavigate?: (path: string) => void;
}

/* Deliberately loud, deliberately ugly. Marks a surface that is a design
   placeholder and not wired to the backend, so it's unmistakable during review.
   See docs/settings-design-backend-followups.md (BACKEND-TODO markers). */
export function NotWired(props: { readonly children?: ReactNode }) {
  return (
    <div className="not-wired" role="note">
      <TriangleAlert size={15} aria-hidden="true" />
      <span>
        <b>DEMO — NOT WIRED.</b>{" "}
        {props.children ?? "Changes here don't persist or take effect yet."}
      </span>
    </div>
  );
}

/* Shared full-datetime formatter for settings panes (#449). Renders a locale
   date+time string, falling back to `fallback` when the input isn't a parseable
   timestamp (NaN guard). Use for any settings surface that shows an absolute
   `toLocaleString()` instant; date-only and the audit `Mon DD · HH:MM` format
   are intentionally separate. */
export function formatTimestamp(iso: string, fallback: string): string {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? fallback : date.toLocaleString();
}

/* Settings shared UI — pane scaffolding (PaneHead/Group/Row/Field/Choice/Note/
   Locked) and thin wrappers over the app's JDS CSS primitives, reused by every
   personal & admin pane. Ported from ui_kits/jarvis-app/settings-ui.jsx. */

/* ---------------------------------------------------------------- Primitives */

export type BadgeTone = "neutral" | "pine" | "amber" | "red" | "steel";

export function Badge(props: {
  readonly tone?: BadgeTone;
  readonly dot?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SharedBadge tone={props.tone === "pine" ? "forest" : props.tone} dot={props.dot}>
      {props.children}
    </SharedBadge>
  );
}

export function ComingSoon(props: { readonly issue: number }) {
  return (
    <Badge tone="steel" dot>
      Coming soon · #{props.issue}
    </Badge>
  );
}

/* --------------------------------------------------------------- Scaffolding */

export function PaneHead(props: { readonly title: string; readonly desc?: string }) {
  return (
    <div className="pane__head">
      <h2 className="pane__title">{props.title}</h2>
      {props.desc ? <p className="pane__desc">{props.desc}</p> : null}
    </div>
  );
}

export function Group(props: {
  readonly title: ReactNode;
  readonly desc?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly tone?: "danger";
}) {
  return (
    <section className={props.tone === "danger" ? "pane__card pane__card--danger" : "pane__card"}>
      <header className="pane__cardhead">
        <div className="pane__cardheadmain">
          <div className="pane__cardtitle">{props.title}</div>
          {props.desc ? <div className="pane__carddesc">{props.desc}</div> : null}
        </div>
        {props.action ? <div className="pane__cardaction">{props.action}</div> : null}
      </header>
      <div className="pane__cardbody">{props.children}</div>
    </section>
  );
}

export function Row(props: {
  readonly name: ReactNode;
  readonly desc?: ReactNode;
  readonly control?: ReactNode;
  readonly comingIssue?: number;
  readonly className?: string;
}) {
  return (
    <div className={["set-row", props.className].filter(Boolean).join(" ")}>
      <div className="set-row__main">
        <div className="set-row__name">{props.name}</div>
        {props.desc ? <div className="set-row__desc">{props.desc}</div> : null}
      </div>
      <div className="set-row__control">
        {props.comingIssue !== undefined ? <ComingSoon issue={props.comingIssue} /> : props.control}
      </div>
    </div>
  );
}

export function Field(props: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  /** Match this to the nested control's id; wrapper children are never cloned. */
  readonly controlId?: string;
  /** Match these to the control's aria-describedby when providing a hint or error. */
  readonly hintId?: string;
  readonly errorId?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const labelId = useId();
  return (
    <div className={`fld${props.className ? ` ${props.className}` : ""}`}>
      {props.controlId ? (
        <label className="fld__lbl" htmlFor={props.controlId} id={labelId}>
          {props.label}
        </label>
      ) : (
        <div className="fld__lbl" id={labelId}>
          {props.label}
        </div>
      )}
      <div
        className="fld__row"
        role={props.controlId ? undefined : "group"}
        aria-labelledby={props.controlId ? undefined : labelId}
      >
        {props.children}
      </div>
      {props.hint ? (
        <div className="fld__hint" id={props.hintId}>
          {props.hint}
        </div>
      ) : null}
      {props.error ? (
        <div className="fld__hint jds-hint--error" id={props.errorId} role="alert">
          {props.error}
        </div>
      ) : null}
    </div>
  );
}

export function Choice(props: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange?: (value: string) => void;
  readonly className?: string;
}) {
  const [value, setValue] = useState(props.value);
  return (
    <div className={`fld${props.className ? ` ${props.className}` : ""}`}>
      <div className="fld__lbl">{props.label}</div>
      <div className="fld__choice">
        <Segmented
          value={value}
          options={props.options}
          ariaLabel={props.label}
          onChange={(next) => {
            setValue(next);
            props.onChange?.(next);
          }}
        />
      </div>
      {props.hint ? <div className="fld__hint">{props.hint}</div> : null}
    </div>
  );
}

export function Note(props: { readonly icon?: ReactNode; readonly children: ReactNode }) {
  return (
    <p className="set2-note">
      {props.icon ?? <Info size={13} aria-hidden="true" />}
      <span>{props.children}</span>
    </p>
  );
}

export function Locked(props: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="adv-locked">
      <div className="adv-locked__ic">{props.icon}</div>
      <div className="adv-locked__t">{props.title}</div>
      <div className="adv-locked__d">{props.children}</div>
    </div>
  );
}
