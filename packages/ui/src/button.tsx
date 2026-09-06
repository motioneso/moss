import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "accentSoft" | "danger" | "field";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly active?: boolean;
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", block, active, icon, children, type, ...rest } = props;
  const classes = [
    "jds-btn",
    `jds-btn--${variant}`,
    size !== "md" ? `jds-btn--${size}` : null,
    block ? "jds-btn--block" : null,
    active ? "jds-btn--active" : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {icon ? <span className="jds-btn__icon">{icon}</span> : null}
      {children}
    </button>
  );
}
