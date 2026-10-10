import { type ReactNode } from "react";

export interface PeekCloseButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly "aria-label"?: string;
}

export function PeekCloseButton({ children, ...rest }: PeekCloseButtonProps) {
  return (
    <button type="button" className="cal-peek__x" aria-label="Close details" {...rest}>
      {children}
    </button>
  );
}
