import type { ReactNode } from "react";
export interface ControlPillProps {
  readonly label: string;
  readonly children: ReactNode;
}
/** Compact, labelled group for a timer and its related controls. */
export function ControlPill({ label, children }: ControlPillProps) {
  return (
    <div className="jds-control-pill" role="group" aria-label={label}>
      {children}
    </div>
  );
}
