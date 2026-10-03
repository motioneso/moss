import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

export interface RowButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly className?: string;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/* A whole row that acts as one button. It strips the native button look so the row's own content
   carries the type. Spacing, hover and layout belong to the screen, passed in through className. */
export function RowButton(props: RowButtonProps) {
  const { className, children, type, ...rest } = props;
  const classes = ["jds-rowbtn", className ?? null].filter(Boolean).join(" ");
  return (
    <button type={type ?? "button"} className={classes} {...rest}>
      {children}
    </button>
  );
}
