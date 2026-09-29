import type { LocaleSettingsDto } from "@moss/shared";

import { calloutCopy, type ChangedBriefingBlock } from "./briefing-callout.js";

/** Morning side column section naming plan blocks that moved since the
    report was prepared. Renders nothing when no block moved. */
export function SinceLastNight(props: {
  readonly changed: readonly ChangedBriefingBlock[];
  readonly locale: LocaleSettingsDto;
}) {
  const copy = calloutCopy(props.changed, props.locale);
  if (!copy) return null;
  return (
    <div className="cmd-next" aria-label="Since last night">
      <div className="rail-block__head">Since last night</div>
      <div className="cmd-next__what">{copy.headline}</div>
      {copy.disclosureLines.map((line) => (
        <p className="cmd-next__note" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}
