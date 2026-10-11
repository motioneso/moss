import type { LocaleSettingsDto } from "@moss/shared";

import { ampm, timeLabel } from "./today-labels.js";

/** Clock digits with a small "am"/"pm" beside them; 24-hour people get the digits alone. */
export function ClockTime(props: { readonly iso: string; readonly locale: LocaleSettingsDto }) {
  const period = ampm(props.iso, props.locale);
  return (
    <>
      {timeLabel(props.iso, props.locale)}
      {period ? <span className="ap"> {period}</span> : null}
    </>
  );
}
