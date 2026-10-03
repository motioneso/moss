import { type ElementType, type ReactNode } from "react";

export interface SectionHeadProps {
  readonly number: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly rule?: boolean;
  readonly align?: "baseline" | "center";
  readonly titleAs?: ElementType;
  readonly titleClassName?: string;
  readonly className?: string;
}

/* Numbered section head: accent number with a gold underline, display title, meta right-aligned.
   Margins belong to the screen; the primitive owns type, colour and the optional rule. */
export function SectionHead(props: SectionHeadProps) {
  const { number, title, meta, rule, align = "baseline", titleAs, className } = props;
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
      <span className="jds-section-head__number">{number}</span>
      <Title
        className={["jds-section-head__title", props.titleClassName].filter(Boolean).join(" ")}
      >
        {title}
      </Title>
      {meta ? <span className="jds-section-head__meta">{meta}</span> : null}
    </div>
  );
}
