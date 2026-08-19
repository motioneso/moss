import releaseNotes from "../../../../docs/WHATS_NEW.md?raw";

import { MarkdownMessage } from "../chat/markdown-message";
import type { PaneProps } from "./settings-types";
import { PaneHead } from "./settings-ui";

export function ReleasedPane(_props: PaneProps) {
  return (
    <>
      <PaneHead
        title="Recently Released"
        desc="See what was added, fixed, and changed in recent Moss releases."
      />
      <MarkdownMessage text={releaseNotes} />
    </>
  );
}
