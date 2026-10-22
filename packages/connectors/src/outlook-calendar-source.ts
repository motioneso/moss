import { isValidTimeZone, strictLocalWallClockToInstant } from "@moss/module-sdk";

/** Only rendered English/Gregorian labels are supported by this source adapter. */
export interface OutlookCalendarObservation {
  readonly occurrenceKey: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly timeZone: string;
}

export class OutlookCalendarSourceError extends Error {
  constructor(
    readonly code: "source-changed" | "partial" | "sign-in-needed",
    readonly stage?: "account" | "timezone" | "calendar" | "coverage"
  ) {
    // Never include a label, address, event ID or upstream exception in an error.
    super(code);
    this.name = "OutlookCalendarSourceError";
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const DAY = "(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)";
const DATE = `${DAY}, (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`;
const CLOCK = "(\\d{1,2}(?::\\d{2})? [AP]M)";
const TIMED = new RegExp(`, ${CLOCK} to ${CLOCK}, ${DATE}(?=,|$)`, "g");
const ALL_DAY = new RegExp(`, all day event, ${DATE}(?: to ${DATE})?(?=,|$)`, "g");

function dateKey(month: string, day: string, year: string): string {
  const key = `${year}-${String(MONTHS.indexOf(month) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    throw new OutlookCalendarSourceError("partial");
  }
  return key;
}

export function addCalendarDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clock(value: string): string {
  const match = /^(\d{1,2})(?::(\d{2}))? ([AP]M)$/.exec(value);
  if (!match) throw new OutlookCalendarSourceError("partial");
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) throw new OutlookCalendarSourceError("partial");
  return `${String((hour % 12) + (match[3] === "PM" ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

export function normalizeOutlookCalendarLabel(
  occurrenceKey: string,
  label: string,
  timeZone: string
): OutlookCalendarObservation {
  if (
    !occurrenceKey ||
    occurrenceKey.length > 512 ||
    label.length > 4000 ||
    !isValidTimeZone(timeZone)
  ) {
    throw new OutlookCalendarSourceError("partial");
  }
  const timed = [...label.matchAll(TIMED)];
  const allDay = [...label.matchAll(ALL_DAY)];
  if (timed.length + allDay.length !== 1) throw new OutlookCalendarSourceError("partial");
  const match = timed[0] ?? allDay[0]!;
  const weekdayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ];
  const dates = new RegExp(
    `(${weekdayNames.join("|")}), (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`,
    "g"
  );
  for (const date of match[0].matchAll(dates)) {
    const key = dateKey(date[2]!, date[3]!, date[4]!);
    if (weekdayNames[new Date(`${key}T00:00:00Z`).getUTCDay()] !== date[1])
      throw new OutlookCalendarSourceError("partial");
  }
  // Outlook may prepend a rendered event charm to its accessible label.
  const title = label
    .slice(0, match.index)
    .replace(/^[^,]{1,40} icon, /, "")
    .trim();
  if (!title || title.length > 1000) throw new OutlookCalendarSourceError("partial");
  try {
    if (allDay.length === 1) {
      const start = dateKey(match[1]!, match[2]!, match[3]!);
      // Outlook displays the last included date; Moss stores an exclusive end date.
      const last = match[4] ? dateKey(match[4], match[5]!, match[6]!) : start;
      if (last < start) throw new OutlookCalendarSourceError("partial");
      return {
        occurrenceKey,
        title,
        startsAt: `${start}T00:00:00.000Z`,
        endsAt: `${addCalendarDays(last, 1)}T00:00:00.000Z`,
        allDay: true,
        timeZone
      };
    }
    const date = dateKey(match[3]!, match[4]!, match[5]!);
    const start = strictLocalWallClockToInstant(`${date}T${clock(match[1]!)}`, timeZone);
    const end = strictLocalWallClockToInstant(`${date}T${clock(match[2]!)}`, timeZone);
    if (end <= start) throw new OutlookCalendarSourceError("partial");
    return {
      occurrenceKey,
      title,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      allDay: false,
      timeZone
    };
  } catch {
    throw new OutlookCalendarSourceError("partial");
  }
}

/** The visible calendar setting is a Windows display name, not an IANA identifier. */
export function outlookDisplayTimeZone(display: string): string {
  const zones: Readonly<Record<string, string>> = {
    "(UTC-08:00) Pacific Time (US & Canada)": "America/Los_Angeles",
    "(UTC-07:00) Mountain Time (US & Canada)": "America/Denver",
    "(UTC-06:00) Central Time (US & Canada)": "America/Chicago",
    "(UTC-05:00) Eastern Time (US & Canada)": "America/New_York",
    "(UTC) Coordinated Universal Time": "UTC"
  };
  const zone = zones[display];
  if (!zone) throw new OutlookCalendarSourceError("source-changed");
  return zone;
}

export function parseOutlookWeekHeader(label: string): { start: string; end: string } {
  const months = `(${MONTHS.join("|")})`;
  const same = new RegExp(
    `^${months} (\\d{1,2})[–-](\\d{1,2}), (\\d{4}), Jump to a specific date or date range\\.$`
  ).exec(label);
  const cross = new RegExp(
    `^${months} (\\d{1,2})(?:, (\\d{4}))? [–-] ${months} (\\d{1,2}), (\\d{4}), Jump to a specific date or date range\\.$`
  ).exec(label);
  let start: string;
  let last: string;
  if (same) {
    start = dateKey(same[1]!, same[2]!, same[4]!);
    last = dateKey(same[1]!, same[3]!, same[4]!);
  } else if (cross) {
    start = dateKey(cross[1]!, cross[2]!, cross[3] ?? cross[6]!);
    last = dateKey(cross[4]!, cross[5]!, cross[6]!);
  } else throw new OutlookCalendarSourceError("source-changed");
  const end = addCalendarDays(last, 1);
  if (addCalendarDays(start, 7) !== end) throw new OutlookCalendarSourceError("source-changed");
  return { start, end };
}
