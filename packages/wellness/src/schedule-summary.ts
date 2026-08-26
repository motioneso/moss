import type { Medication } from "@moss/db";

import {
  expandOccurrences,
  type MedicationSchedule,
  type ScheduleAnchor,
  type Weekday,
  type WeekdayPosition
} from "./occurrence-engine.js";
import { dateKeyFromColumn } from "./schedule.js";

/**
 * #1969 — plain-language schedule summary and next-three-doses preview, for the medication
 * builder form (piece 3, not built here). Unlike `computeSchedule` in `schedule.ts`, which pins
 * some schedule families to a UTC-only naive-civil-time model for the day-grid screen (see that
 * file's module comment), both functions here always use the medication's own stored time zone —
 * a summary sentence and a forward-looking preview are read against real calendar dates.
 */

const NO_START_DATE_GATING = "1970-01-01";
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Returns the next `count` scheduled dose instants at or after `from`. Empty for an as-needed
 *  medication, or a schedule that produces no occurrence within a two-year lookahead window. */
export function nextDoses(medication: Medication, from: Date, count = 3): Date[] {
  const mapped = toSummaryEngineInput(medication);
  if (!mapped) return [];

  const occurrences = expandOccurrences(mapped.schedule, mapped.anchor, {
    from,
    to: new Date(from.getTime() + TWO_YEARS_MS)
  });
  return occurrences.slice(0, count).map((o) => o.at);
}

/** Returns a plain-language sentence describing when `medication` is taken. */
export function describeSchedule(medication: Medication): string {
  const tz = medication.time_zone ?? "UTC";
  const times = medication.schedule_times ?? [];

  switch (medication.frequency_type) {
    case "as_needed":
      return "As needed.";

    case "once_daily":
    case "times_per_day":
      return `${countPhrase(times.length)}, at ${formatTimeList(times, tz)}.`;

    case "specific_weekdays":
      return `Every ${formatWeekdayList((medication.weekdays ?? []) as Weekday[])}, at ${formatTimeList(times, tz)}.`;

    case "every_n_hours":
      return `Every ${medication.interval_hours} hours, starting at ${formatTimeList(times, tz)}.`;

    case "cyclical": {
      const anchorDate = medication.cycle_anchor_date
        ? formatDate(dateKeyFromColumn(medication.cycle_anchor_date), tz)
        : null;
      const start = anchorDate ? `, starting ${anchorDate}` : "";
      return `${medication.cycle_days_on} days on, ${medication.cycle_days_off} days off${start}, at ${formatTimeList(times, tz)}.`;
    }

    case "every_interval": {
      const start = medication.schedule_start_date
        ? formatDate(dateKeyFromColumn(medication.schedule_start_date), tz)
        : null;
      const startPhrase = start ? `, starting ${start}` : "";
      const timePhrase = `, at ${formatTimeList(times, tz)}`;

      let intervalPhrase: string;
      if (medication.interval_unit === "weeks") {
        const weekdays = formatWeekdayList((medication.weekdays ?? []) as Weekday[]);
        intervalPhrase = `Every ${medication.interval_count} weeks on ${weekdays}`;
      } else if (medication.interval_unit === "months") {
        intervalPhrase = `Every ${medication.interval_count} months`;
      } else {
        intervalPhrase = `Every ${medication.interval_count} days`;
      }

      return withEndDate(`${intervalPhrase}${startPhrase}${timePhrase}.`, medication, tz);
    }

    case "monthly": {
      const timePhrase = `, at ${formatTimeList(times, tz)}`;
      if (medication.month_kind === "weekdayPosition") {
        const position = medication.month_weekday_position ?? "first";
        const weekday = weekdayName((medication.month_weekday ?? 1) as Weekday);
        return withEndDate(
          `On the ${position} ${weekday} of each month${timePhrase}.`,
          medication,
          tz
        );
      }
      const dayPhrase = medication.month_day_is_last
        ? "the last day"
        : `the ${ordinal(medication.month_day ?? 1)}`;
      return withEndDate(`On ${dayPhrase} of each month${timePhrase}.`, medication, tz);
    }

    default:
      return "As needed.";
  }
}

/** Mirrors `toEngineInput` in `schedule.ts`, but every branch's time zone is the medication's
 *  own stored zone (falling back to UTC), not hardcoded UTC for the open-anchor families. */
function toSummaryEngineInput(
  medication: Medication
): { schedule: MedicationSchedule; anchor: ScheduleAnchor } | null {
  if (medication.frequency_type === "as_needed") return null;

  const tz = medication.time_zone ?? "UTC";
  const doseTimes = medication.schedule_times ?? [];
  const openAnchor: ScheduleAnchor = { startDate: NO_START_DATE_GATING, timeZone: tz };

  if (medication.frequency_type === "specific_weekdays") {
    return {
      schedule: {
        family: "selectedDays",
        weekdays: (medication.weekdays ?? []) as Weekday[],
        doseTimes
      },
      anchor: openAnchor
    };
  }

  if (medication.frequency_type === "every_n_hours") {
    return {
      schedule: {
        family: "daily",
        doseTimes: everyNHoursDoseTimes(medication.interval_hours, doseTimes[0])
      },
      anchor: openAnchor
    };
  }

  if (medication.frequency_type === "cyclical") {
    const cycleLength = (medication.cycle_days_on ?? 0) + (medication.cycle_days_off ?? 0);
    if (!medication.cycle_anchor_date || !medication.cycle_days_on || cycleLength <= 0) {
      return { schedule: { family: "daily", doseTimes }, anchor: openAnchor };
    }
    return {
      schedule: {
        family: "cycle",
        daysOn: medication.cycle_days_on,
        daysOff: medication.cycle_days_off ?? 0,
        doseTimes
      },
      anchor: { startDate: dateKeyFromColumn(medication.cycle_anchor_date), timeZone: tz }
    };
  }

  if (medication.frequency_type === "every_interval") {
    const anchor: ScheduleAnchor = {
      startDate: dateKeyFromColumn(medication.schedule_start_date!),
      endDate: medication.schedule_end_date
        ? dateKeyFromColumn(medication.schedule_end_date)
        : null,
      timeZone: tz
    };
    if (medication.interval_unit === "weeks") {
      return {
        schedule: {
          family: "everyInterval",
          unit: "weeks",
          interval: medication.interval_count!,
          weekdays: (medication.weekdays ?? []) as Weekday[],
          doseTimes
        },
        anchor
      };
    }
    return {
      schedule: {
        family: "everyInterval",
        unit: medication.interval_unit === "months" ? "months" : "days",
        interval: medication.interval_count!,
        doseTimes
      },
      anchor
    };
  }

  if (medication.frequency_type === "monthly") {
    const anchor: ScheduleAnchor = {
      startDate: dateKeyFromColumn(medication.schedule_start_date!),
      endDate: medication.schedule_end_date
        ? dateKeyFromColumn(medication.schedule_end_date)
        : null,
      timeZone: tz
    };
    if (medication.month_kind === "weekdayPosition") {
      return {
        schedule: {
          family: "monthly",
          kind: "weekdayPosition",
          position: medication.month_weekday_position as WeekdayPosition,
          weekday: medication.month_weekday as Weekday,
          doseTimes
        },
        anchor
      };
    }
    return {
      schedule: {
        family: "monthly",
        kind: "date",
        dayOfMonth: medication.month_day_is_last ? "last" : (medication.month_day as number),
        doseTimes
      },
      anchor
    };
  }

  // once_daily, times_per_day
  return { schedule: { family: "daily", doseTimes }, anchor: openAnchor };
}

function everyNHoursDoseTimes(
  intervalHours: number | null,
  anchorTime: string | undefined
): string[] {
  if (!intervalHours || intervalHours <= 0) return [];
  const [hourStr, minuteStr] = (anchorTime ?? "00:00").split(":");
  const startMinutes = Number(hourStr ?? 0) * 60 + Number(minuteStr ?? 0);
  const stepMinutes = intervalHours * 60;

  const times: string[] = [];
  for (let t = startMinutes; t < 24 * 60; t += stepMinutes) {
    const hour = Math.floor(t / 60);
    const minute = t % 60;
    times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return times;
}

function countPhrase(count: number): string {
  if (count <= 1) return "Once a day";
  if (count === 2) return "Twice a day";
  return `${count} times a day`;
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday"
};

function weekdayName(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday];
}

/** Formats a list of ISO weekdays as full names in Mon..Sun order, deduplicated, joined with an
 *  Oxford comma for three or more. */
function formatWeekdayList(weekdays: readonly Weekday[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  return joinWithAnd(sorted.map(weekdayName));
}

/** Formats a list of "HH:MM" civil clock times as `h:mm AM/PM`, joined with an Oxford comma for
 *  three or more. The times are already civil-local (they come straight off the medication row,
 *  interpreted in the medication's own time zone), so this only needs 24h -> 12h formatting, not
 *  a zone conversion. */
function formatTimeList(times: readonly string[], tz: string): string {
  return joinWithAnd(times.map(formatClockTime));
}

function formatClockTime(time: string): string {
  const [hourStr, minuteStr] = time.split(":");
  const hour = Number(hourStr ?? 0);
  const minute = Number(minuteStr ?? 0);
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Formats a YYYY-MM-DD civil date key as `"15 June 2026"`. `tz` is accepted for symmetry with
 *  the rest of this module but unused: a date key has no time component to convert. */
function formatDate(dateKey: string, _tz: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
  return formatted;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function withEndDate(sentence: string, medication: Medication, tz: string): string {
  if (!medication.schedule_end_date) return sentence;
  const endDate = formatDate(dateKeyFromColumn(medication.schedule_end_date), tz);
  return `${sentence.slice(0, -1)}, until ${endDate}.`;
}
