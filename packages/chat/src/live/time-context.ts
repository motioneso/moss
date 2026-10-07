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
    `Current UTC time: ${instant.toISOString()} (${utcWeekday}).`,
    "Tool-result timestamps such as createdAt and updatedAt describe the record's own event time, not the current time. ISO 8601 timestamps ending in Z are UTC; a numeric offset belongs to the source timestamp. Read ISO clock hours as 24-hour time and preserve the original instant. If a timestamp has no time zone, do not infer one."
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
      "Keep this local date, weekday, time and time zone in mind for accuracy, but do not volunteer them: mention the date, time, weekday or time zone only when the user asks about them or they are directly relevant to the answer. When you do mention them, state them as fact. Do not hedge about them, re-derive them, or offer other time zones unless the user asks.",
      `When presenting a tool-result timestamp, convert that instant to the user's time zone (${timezone}) unless another zone was requested. Apply the offset in effect at that timestamp (including daylight saving), not necessarily the current offset above, and carry any date change across midnight. Never relabel the raw UTC clock as local or change only AM/PM. If you cannot reliably convert, show the original timestamp with its explicit zone instead of guessing.`
    );
  } else {
    lines.push(
      "The user's local time zone is not known this turn.",
      "If you mention the current time, say plainly — once, the first time you mention it — that you do not know their local time zone, then use the UTC instant above, converted only if the user requests a specific time zone. Never guess the user's time zone, region or location, never name a time zone or offset you were not given, and do not show time zone arithmetic unless the user asks for it.",
      "With no known local time zone, preserve tool timestamps in their explicit source zone unless the user requests a specific target time zone; do not label them as the user's local time. For a requested target zone, apply its offset at the timestamp (including daylight saving) and carry any date change across midnight. If conversion is uncertain, retain the explicit source zone."
    );
  }
  lines.push(
    "This is the authoritative current time for this turn; it supersedes any earlier date or time context in this conversation.",
    "Stay consistent with the authoritative time for each turn: let the date and weekday move forward when the current time does, and do not flip-flop about the known time zone."
  );
  lines.push("</current_time_context>");
  return lines.join("\n");
}
