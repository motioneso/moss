import { type ElementType, type ReactNode } from "react";

export interface SectionHeadProps {
  readonly title: ReactNode;
  /** Section number, underlined in gold, for numbered editorial sections. */
  readonly number?: ReactNode;
  /** Small decorative mark before the title, such as a status dot. */
  readonly marker?: ReactNode;
  readonly meta?: ReactNode;
  readonly rule?: boolean;
  readonly align?: "baseline" | "center";
  readonly titleAs?: ElementType;
  /** Id on the title, for a section's aria-labelledby. */
  readonly titleId?: string;
  readonly titleClassName?: string;
  readonly className?: string;
}

/* Section head: optional accent number with a gold underline, display title, meta right-aligned.
   Margins belong to the screen; the primitive owns type, colour and the optional rule. */
export function SectionHead(props: SectionHeadProps) {
  const { number, marker, title, meta, rule, align = "baseline", titleAs, className } = props;
  const Title = titleAs ?? "h2";
  const classes = [
    "jds-section-head",
    align === "center" ? "jds-section-head--center" : null,
    rule ? "jds-section-head--rule" : null,
    className ?? null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      {number !== undefined ? <span className="jds-section-head__number">{number}</span> : null}
      {marker !== undefined ? (
        <span className="jds-section-head__marker" aria-hidden="true">
          {marker}
        </span>
      ) : null}
      <Title
        className={["jds-section-head__title", props.titleClassName].filter(Boolean).join(" ")}
        id={props.titleId}
      >
        {title}
      </Title>
      {meta ? <span className="jds-section-head__meta">{meta}</span> : null}
    </div>
  );
}
