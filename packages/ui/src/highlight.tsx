import type { ReactNode } from "react";
export interface HighlightProps {
  readonly children: ReactNode;
}
export function Highlight({ children }: HighlightProps) {
  return <mark className="jds-highlight">{children}</mark>;
}
