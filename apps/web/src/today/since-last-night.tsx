import type { LocaleSettingsDto } from "@moss/shared";

import { calloutCopy, type ChangedBriefingBlock } from "./briefing-callout.js";

const PROPOSED_SUFFIX = " (proposed, not yet on the calendar)";

/** Morning side column section naming plan blocks that moved since the
    report was prepared. Renders nothing when no block moved. */
export function SinceLastNight(props: {
  readonly changed: readonly ChangedBriefingBlock[];
  readonly locale: LocaleSettingsDto;
}) {
  const copy = calloutCopy(props.changed, props.locale);
  if (!copy) return null;
  const single = props.changed.length === 1 ? props.changed[0] : undefined;
  // Proposed moves must never read as confirmed times.
  const headline = single ? copy.sentence : copy.headline;
  const lines = copy.disclosureLines.map((line, index) =>
    props.changed[index]?.proposed ? `${line}${PROPOSED_SUFFIX}` : line
  );
  return (
    <div className="cmd-next" aria-label="Since last night">
      <div className="rail-block__head">Since last night</div>
      <div className="cmd-next__what">{headline}</div>
      {lines.map((line) => (
        <p className="cmd-next__note" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}
