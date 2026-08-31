import { isValidTimeZone, localDayKey, timeZoneOffsetMinutes } from "@moss/module-sdk/time";

/**
 * Renders the per-turn `<current_time_context>` block: the fresh UTC instant always, plus a local
 * representation only when `timezone` is a resolvable IANA zone. Pure function of its inputs so
 * midnight and DST behaviour are deterministic in tests (#1869 spec decisions 3 and 6).
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
      `User's local time: ${localDate} (${localWeekday}) ${localTime} (${timezone}, UTC offset ${offsetMinutes} minutes).`
    );
  }
  lines.push(
    "This is the authoritative current time for this turn; it supersedes any earlier date or time context in this conversation."
  );
  lines.push("</current_time_context>");
  return lines.join("\n");
}
