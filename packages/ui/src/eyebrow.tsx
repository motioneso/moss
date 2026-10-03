import { type ElementType, type ReactNode } from "react";

export type EyebrowTone = "subtle" | "gold" | "muted" | "accent" | "hero";

export interface EyebrowProps {
  readonly tone?: EyebrowTone;
  readonly as?: ElementType;
  readonly className?: string;
  readonly children?: ReactNode;
}

/* Bold caps label at the 11px floor. */
export function Eyebrow(props: EyebrowProps) {
  const { tone = "subtle", as, className, children } = props;
  const Tag = as ?? "span";
  const classes = [
    "jds-eyebrow",
    "jds-eyebrow--strong",
    tone !== "subtle" ? `jds-eyebrow--${tone}` : null,
    className ?? null
  ]
    .filter(Boolean)
    .join(" ");
  return <Tag className={classes}>{children}</Tag>;
}
