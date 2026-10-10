import { type ReactNode } from "react";

/** Canonical public tones. Legacy settings "pine" is translated to "forest" at the
 * settings adapter boundary; the CSS alias remains for existing external callers. */
export type BadgeTone =
  | "neutral"
  | "forest"
  | "amber"
  | "red"
  | "steel"
  | "solid-pine"
  | "solid-amber";

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly outline?: boolean;
  readonly pill?: boolean;
  readonly dot?: boolean;
  readonly children: ReactNode;
}

export function Badge(props: BadgeProps) {
  const tone = props.tone ?? "neutral";
  const classes = [
    "jds-badge",
    props.outline ? "jds-badge--outline" : `jds-badge--${tone}`,
    props.pill ? "jds-badge--pill" : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes}>
      {props.dot ? <span className="jds-badge__dot" /> : null}
      {props.children}
    </span>
  );
}

export function ComingSoon(props: { readonly issue: number }) {
  return (
    <Badge tone="steel" dot>
      Coming soon · #{props.issue}
    </Badge>
  );
}
