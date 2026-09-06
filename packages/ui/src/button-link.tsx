import { type AnchorHTMLAttributes, type ReactNode } from "react";

export type ButtonLinkVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "accentSoft"
  | "danger"
  | "field";
export type ButtonLinkSize = "sm" | "md" | "lg";

export interface ButtonLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "className"
> {
  readonly href: string;
  readonly variant?: ButtonLinkVariant;
  readonly size?: ButtonLinkSize;
  readonly block?: boolean;
  readonly icon?: ReactNode;
  readonly children?: ReactNode;
}

export function buttonLinkClassName(
  variant: ButtonLinkVariant = "primary",
  size: ButtonLinkSize = "md",
  block = false
): string {
  return [
    "jds-btn",
    `jds-btn--${variant}`,
    size !== "md" ? `jds-btn--${size}` : null,
    block ? "jds-btn--block" : null
  ]
    .filter(Boolean)
    .join(" ");
}

export function ButtonLink(props: ButtonLinkProps) {
  const { variant = "primary", size = "md", block, icon, children, href, ...rest } = props;
  const classes = buttonLinkClassName(variant, size, block);
  return (
    <a href={href} className={classes} {...rest}>
      {icon ? <span className="jds-btn__icon">{icon}</span> : null}
      {children}
    </a>
  );
}
