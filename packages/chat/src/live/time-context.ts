import { isValidTimeZone, localDayKey, timeZoneOffsetMinutes } from "@moss/module-sdk/time";

/**
 * Renders the per-turn `<current_time_context>` block: the fresh UTC instant always, plus a local
 * representation only when `timezone` is a resolvable IANA zone. Pure function of its inputs so
 * midnight and DST behaviour are deterministic in tests (#1869 spec decisions 3 and 6).
 *
 * The block also carries the rules for TALKING about time. Zone detection is deliberately out of
 * scope for this slice, so an unknown zone must be admitted once, plainly, and never guessed at
 * from the UTC offset — the run_6 live demo had the model assert "Pacific Daylight Time", retract
 * it a turn later, infer the user's region out loud, and botch offset arithmetic mid-sentence.
 */
export function renderCurrentTimeContext(instant: Date, timezone: string | null): string {
  const utcWeekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long"
  }).format(instant);
  const lines = [
    "<current_time_context>",
    `Current UTC time: ${instant.toISOString()} (${utcWeekday}).`
  ];
  if (timezone && isValidTimeZone(timezone)) {
    const localDate = localDayKey(instant, timezone);
    const localWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long"
    }).format(instant);
    const localTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit"
    }).format(instant);
    const offsetMinutes = timeZoneOffsetMinutes(instant, timezone);
    lines.push(
      `User's local time: ${localDate} (${localWeekday}) ${localTime} (${timezone}, UTC offset ${offsetMinutes} minutes).`,
      "State that local date, weekday, time and time zone as fact. Do not hedge about them, re-derive them, or offer other time zones unless the user asks."
    );
  } else {
    lines.push(
      "The user's local time zone is not known this turn.",
      "If you mention the time, say plainly — once, the first time you mention it — that you do not know their local time zone, then answer from the UTC time above. Never guess the user's time zone, region or location, never name a time zone or offset you were not given, and do not show time zone arithmetic unless the user asks for it."
    );
  }
  lines.push(
    "This is the authoritative current time for this turn; it supersedes any earlier date or time context in this conversation.",
    "Say the same thing about the date, weekday and time zone every time it comes up in this conversation; never contradict an earlier turn about them."
  );
  lines.push("</current_time_context>");
  return lines.join("\n");
}
