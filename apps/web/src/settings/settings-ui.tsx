import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { DisclosureToggle } from "@moss/ui";

export { Avatar, Badge, ComingSoon, Indicator, Segmented, Select, Switch } from "@moss/ui";
export type { BadgeTone } from "@moss/ui";
export * from "@moss/settings-ui";

const COLLAPSED_PREFIX = "moss.settings.group-open.";

function readOpen(storageKey: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(COLLAPSED_PREFIX + storageKey);
    return saved === null ? fallback : saved === "1";
  } catch {
    return fallback;
  }
}

/**
 * A settings group that starts collapsed and shows a one-line summary of its current state. The
 * open or closed choice is remembered per browser. Closed content stays mounted, so nothing in it
 * is lost or reordered.
 */
export function CollapsibleGroup(props: {
  readonly title: ReactNode;
  readonly summary: ReactNode;
  readonly storageKey: string;
  readonly titleAs?: "h2" | "h3" | "h4" | "h5" | "h6";
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const bodyId = useId();
  const Title = props.titleAs ?? "h3";
  const [open, setOpen] = useState(() => readOpen(props.storageKey, props.defaultOpen ?? false));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(COLLAPSED_PREFIX + props.storageKey, next ? "1" : "0");
    } catch {
      // Storage can be blocked. The section still opens for this visit.
    }
  };
  return (
    <section className="pane__card pane__card--collapsible">
      <header className="pane__cardhead">
        <div className="pane__cardheadmain">
          <Title className="pane__cardtitle">
            <DisclosureToggle
              className="pane__cardtoggle"
              expanded={open}
              controls={bodyId}
              onClick={toggle}
            >
              <span>{props.title}</span>
              <ChevronDown size={16} aria-hidden="true" className="pane__cardchevron" />
            </DisclosureToggle>
          </Title>
          <div className="pane__carddesc">{props.summary}</div>
        </div>
      </header>
      <div id={bodyId} className="pane__cardbody" hidden={!open}>
        {props.children}
      </div>
    </section>
  );
}
