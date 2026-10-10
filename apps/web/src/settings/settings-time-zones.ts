import { formatInZone } from "@moss/shared";
import type { ComboboxOption } from "@moss/ui";

function timeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const label = formatInZone(date, timeZone, { timeZoneName: "shortOffset" }, "en-US");
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(label);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function formatTimeZoneOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

// Sorted by UTC offset (then name) and labeled with that offset, rather than
// the browser's arbitrary IANA-list order — the plain list read as unsorted noise.
const SUPPORTED_TIME_ZONES = Intl.supportedValuesOf("timeZone")
  .map((timeZone) => {
    const offsetMinutes = timeZoneOffsetMinutes(timeZone, new Date());
    return {
      timeZone,
      offsetMinutes,
      label: `(${formatTimeZoneOffset(offsetMinutes)}) ${timeZone}`
    };
  })
  .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.timeZone.localeCompare(b.timeZone));

// Searchable picker options: "(UTC-08:00) America/Los_Angeles" also matches "los angeles".
export const TIME_ZONE_OPTIONS: readonly ComboboxOption[] = SUPPORTED_TIME_ZONES.map((zone) => ({
  value: zone.timeZone,
  label: zone.label,
  keywords: zone.timeZone.replace(/[_/]/g, " ")
}));
