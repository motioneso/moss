import { type ElementType, type ReactNode } from "react";

export type NoteVariant = "plan" | "pull" | "practical";

export interface NoteProps {
  readonly variant: NoteVariant;
  readonly as?: ElementType;
  readonly className?: string;
  readonly children?: ReactNode;
}

/* Small tinted note. plan = the day-plan strip, pull = gold-ruled pull note,
   practical = sage rail note. Width and margins belong to the screen. */
export function Note(props: NoteProps) {
  const { variant, as, className, children } = props;
  const Tag = as ?? "div";
  const classes = ["jds-note", `jds-note--${variant}`, className ?? null].filter(Boolean).join(" ");
  return <Tag className={classes}>{children}</Tag>;
}
