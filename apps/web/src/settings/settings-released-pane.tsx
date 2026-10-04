import releaseNotes from "../../../../docs/WHATS_NEW.md?raw";

import { MarkdownMessage } from "../chat/markdown-message";
import type { PaneProps } from "./settings-types";
import { PaneHead } from "./settings-ui";
import { personalize } from "../api/use-assistant-name";

function edgeChannelFirst(markdown: string): string {
  const firstSection = markdown.search(/^## /m);
  const edgeStart = markdown.search(/^## Edge channel(?: — .*)?$/m);
  if (edgeStart <= firstSection) return markdown;

  const nextSection = markdown.indexOf("\n## ", edgeStart + 1);
  const edgeEnd = nextSection === -1 ? markdown.length : nextSection + 1;
  return (
    markdown.slice(0, firstSection) +
    markdown.slice(edgeStart, edgeEnd) +
    markdown.slice(firstSection, edgeStart) +
    markdown.slice(edgeEnd)
  );
}

export function ReleasedPane(_props: PaneProps) {
  return (
    <>
      <PaneHead
        title="What's new"
        desc={personalize("See what was added, fixed, and changed in recent Moss releases.")}
      />
      <MarkdownMessage text={edgeChannelFirst(releaseNotes)} />
    </>
  );
}
