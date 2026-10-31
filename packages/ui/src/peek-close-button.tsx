import { X } from "lucide-react";
import { type ReactNode } from "react";

export interface PeekCloseButtonProps {
  /** Defaults to the shared close cross, so callers without an icon set still match. */
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly "aria-label"?: string;
}

export function PeekCloseButton({ children, ...rest }: PeekCloseButtonProps) {
  return (
    <button type="button" className="cal-peek__x" aria-label="Close details" {...rest}>
      {children ?? <X size={17} aria-hidden="true" />}
    </button>
  );
}
