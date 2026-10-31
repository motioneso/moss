import { type ReactNode } from "react";

export interface SelectionBarProps {
  /** Names the region, e.g. "Selected transactions". */
  readonly "aria-label": string;
  readonly children: ReactNode;
}

/** Actions for the rows a list has selected. Render it after the list and only while something is
    selected; it sticks to the bottom of the viewport while the list scrolls. */
export function SelectionBar(props: SelectionBarProps) {
  return (
    <section className="jds-selbar" aria-label={props["aria-label"]}>
      {props.children}
    </section>
  );
}
