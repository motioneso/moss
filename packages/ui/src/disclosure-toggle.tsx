import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

export interface DisclosureToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "aria-expanded" | "aria-controls"
> {
  readonly expanded: boolean;
  /* The id of the region this button shows and hides. */
  readonly controls?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/* A text button that expands and collapses a region, announcing its state through aria-expanded.
   It strips the native button look. The open and closed marker and the spacing belong to the
   screen. The shared ::after owns the phone hit target; render a visual marker as an
   aria-hidden child, never by replacing ::after. */
export function DisclosureToggle(props: DisclosureToggleProps) {
  const { expanded, controls, className, children, type, ...rest } = props;
  const classes = ["jds-disclosure", className ?? null].filter(Boolean).join(" ");
  return (
    <button
      type={type ?? "button"}
      className={classes}
      aria-expanded={expanded}
      aria-controls={controls}
      {...rest}
    >
      {children}
    </button>
  );
}
