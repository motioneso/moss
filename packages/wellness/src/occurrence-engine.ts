import { localDay } from "@moss/shared";

/**
 * The shared medication occurrence engine (first slice of #1349, issue #1950).
 *
 * Given a schedule description and a date range, `expandOccurrences` answers "when are the
 * doses for this schedule". It is pure and knows nothing about the database, the four existing
 * screens that each do their own date math, or reminders — those are wired in a later slice.
 *
 * Six schedule families, matching the spec on issue #1950 / #1349:
 * daily, selected days, every interval (days / weeks-with-weekdays / months), monthly (numbered
 * date, weekday position, or last day of month), cycle (N on / M off), and as needed (never
 * produces an occurrence).
 */

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WeekdayPosition = "first" | "second" | "third" | "fourth" | "last";

export interface DailySchedule {
  readonly family: "daily";
  readonly doseTimes: readonly string[];
}

export interface SelectedDaysSchedule {
  readonly family: "selectedDays";
  readonly weekdays: readonly Weekday[];
  readonly doseTimes: readonly string[];
}

export interface EveryNDaysSchedule {
  readonly family: "everyInterval";
  readonly unit: "days";
  readonly interval: number;
  readonly doseTimes: readonly string[];
}

export interface EveryNWeeksSchedule {
  readonly family: "everyInterval";
  readonly unit: "weeks";
  readonly interval: number;
  readonly weekdays: readonly Weekday[];
  readonly doseTimes: readonly string[];
}

export interface EveryNMonthsSchedule {
  readonly family: "everyInterval";
  readonly unit: "months";
  readonly interval: number;
  readonly doseTimes: readonly string[];
}

export type EveryIntervalSchedule =
  | EveryNDaysSchedule
  | EveryNWeeksSchedule
  | EveryNMonthsSchedule;

export interface MonthlyDateSchedule {
  readonly family: "monthly";
  readonly kind: "date";
  /** 1-31, or "last" for the last day of the month. Never clamped: a date absent from a given
   *  month (e.g. the 31st in April) simply produces no occurrence that month. */
  readonly dayOfMonth: number | "last";
  readonly doseTimes: readonly string[];
}

export interface MonthlyWeekdaySchedule {
  readonly family: "monthly";
  readonly kind: "weekdayPosition";
  /** "last" means the final matching weekday in the month, not a fixed fifth occurrence. */
  readonly position: WeekdayPosition;
  readonly weekday: Weekday;
  readonly doseTimes: readonly string[];
}

export type MonthlySchedule = MonthlyDateSchedule | MonthlyWeekdaySchedule;

export interface CycleSchedule {
  readonly family: "cycle";
  readonly daysOn: number;
  readonly daysOff: number;
  readonly doseTimes: readonly string[];
}

export interface AsNeededSchedule {
  readonly family: "asNeeded";
}

export type MedicationSchedule =
  | DailySchedule
  | SelectedDaysSchedule
  | EveryIntervalSchedule
  | MonthlySchedule
  | CycleSchedule
  | AsNeededSchedule;

export interface ScheduleAnchor {
  /** Local civil date (YYYY-MM-DD) the schedule starts. Interval/cycle families count from here;
   *  logging or completion never shifts it. */
  readonly startDate: string;
  /** Local civil date (YYYY-MM-DD), inclusive. Omit or null for no end. */
  readonly endDate?: string | null;
  /** IANA time zone the schedule's clock times are fixed to. */
  readonly timeZone: string;
}

export interface DateRange {
  /** Inclusive lower bound instant. */
  readonly from: Date;
  /** Inclusive upper bound instant. */
  readonly to: Date;
}

export interface Occurrence {
  /** Local civil date (YYYY-MM-DD) this occurrence falls on. */
  readonly date: string;
  /** Local clock time ("HH:MM") this occurrence was scheduled for. */
  readonly time: string;
  /** The UTC instant the dose is due. */
  readonly at: Date;
}

/**
 * Returns the dose occurrences for `schedule` that fall within `range`, honoring `anchor`'s
 * start date, optional end date, and time zone. As-needed schedules always return no occurrences.
 */
export function expandOccurrences(
  schedule: MedicationSchedule,
  anchor: ScheduleAnchor,
  range: DateRange
): Occurrence[] {
  if (schedule.family === "asNeeded") return [];

  const tz = anchor.timeZone;
  const startDate = anchor.startDate;
  const endDate = anchor.endDate ?? null;

  // Bound the day-by-day scan to the overlap of [startDate, endDate] and the requested instant
  // range, expanded by a day on each side so a dose time near a civil-day boundary in `tz`
  // still gets considered.
  const scanFrom = maxDateKey(startDate, addDays(localDay(range.from, tz), -1));
  const scanToUnbounded = addDays(localDay(range.to, tz), 1);
  const scanTo = endDate ? minDateKey(endDate, scanToUnbounded) : scanToUnbounded;

  if (compareDateKeys(scanFrom, scanTo) > 0) return [];

  const occurrences: Occurrence[] = [];
  for (let dateKey = scanFrom; compareDateKeys(dateKey, scanTo) <= 0; dateKey = addDays(dateKey, 1)) {
    if (!isEligibleDay(schedule, startDate, dateKey)) continue;
    for (const time of schedule.doseTimes) {
      const at = zonedTimeToUtc(tz, dateKey, time);
      if (at.getTime() < range.from.getTime() || at.getTime() > range.to.getTime()) continue;
      occurrences.push({ date: dateKey, time, at });
    }
  }

  occurrences.sort((a, b) => a.at.getTime() - b.at.getTime());
  return occurrences;
}

function isEligibleDay(
  schedule: Exclude<MedicationSchedule, AsNeededSchedule>,
  startDateKey: string,
  dateKey: string
): boolean {
  if (compareDateKeys(dateKey, startDateKey) < 0) return false;

  switch (schedule.family) {
    case "daily":
      return true;
    case "selectedDays":
      return schedule.weekdays.includes(isoWeekday(dateKey));
    case "everyInterval":
      return isEligibleInterval(schedule, startDateKey, dateKey);
    case "monthly":
      return isEligibleMonthly(schedule, dateKey);
    case "cycle":
      return isEligibleCycle(schedule, startDateKey, dateKey);
  }
}

function isEligibleInterval(
  schedule: EveryIntervalSchedule,
  startDateKey: string,
  dateKey: string
): boolean {
  if (schedule.interval < 1) return false;

  if (schedule.unit === "days") {
    const elapsed = diffDays(startDateKey, dateKey);
    return elapsed % schedule.interval === 0;
  }

  if (schedule.unit === "weeks") {
    if (!schedule.weekdays.includes(isoWeekday(dateKey))) return false;
    const startWeekStart = addDays(startDateKey, -(isoWeekday(startDateKey) - 1));
    const dateWeekStart = addDays(dateKey, -(isoWeekday(dateKey) - 1));
    const weeksElapsed = diffDays(startWeekStart, dateWeekStart) / 7;
    return weeksElapsed % schedule.interval === 0;
  }

  // months: same day-of-month as the anchor, `interval` months apart. A month lacking that
  // day-of-month (e.g. day 31 in April) never matches — no clamping.
  const [startYear, startMonth, startDay] = keyParts(startDateKey);
  const [year, month, day] = keyParts(dateKey);
  if (day !== startDay) return false;
  const monthsElapsed = (year - startYear) * 12 + (month - startMonth);
  return monthsElapsed >= 0 && monthsElapsed % schedule.interval === 0;
}

function isEligibleMonthly(schedule: MonthlySchedule, dateKey: string): boolean {
  const [year, month, day] = keyParts(dateKey);

  if (schedule.kind === "date") {
    if (schedule.dayOfMonth === "last") {
      return day === daysInMonth(year, month);
    }
    return day === schedule.dayOfMonth;
  }

  if (isoWeekday(dateKey) !== schedule.weekday) return false;
  const ordinal = Math.ceil(day / 7); // 1..5, which occurrence of this weekday in the month
  if (schedule.position === "last") {
    return day + 7 > daysInMonth(year, month);
  }
  const wanted = { first: 1, second: 2, third: 3, fourth: 4 }[schedule.position];
  return ordinal === wanted;
}

function isEligibleCycle(schedule: CycleSchedule, startDateKey: string, dateKey: string): boolean {
  const cycleLength = schedule.daysOn + schedule.daysOff;
  if (cycleLength <= 0 || schedule.daysOn <= 0) return false;
  const elapsed = diffDays(startDateKey, dateKey);
  return elapsed % cycleLength < schedule.daysOn;
}

// --- Calendar-key helpers (all operate on YYYY-MM-DD strings, no timezone involved) ---

function keyParts(dateKey: string): [number, number, number] {
  const parts = dateKey.split("-");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** ISO weekday of a YYYY-MM-DD key: 1 = Monday .. 7 = Sunday. */
function isoWeekday(dateKey: string): Weekday {
  const [year, month, day] = keyParts(dateKey);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return (jsDay === 0 ? 7 : jsDay) as Weekday;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = keyParts(dateKey);
  return dateKeyOf(new Date(Date.UTC(year, month - 1, day + days)));
}

function diffDays(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = keyParts(fromKey);
  const [ty, tm, td] = keyParts(toKey);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86_400_000);
}

function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxDateKey(a: string, b: string): string {
  return compareDateKeys(a, b) >= 0 ? a : b;
}

function minDateKey(a: string, b: string): string {
  return compareDateKeys(a, b) <= 0 ? a : b;
}

function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// --- Time zone conversion, with explicit daylight-saving gap and fold handling ---

/**
 * Converts a local wall clock (YYYY-MM-DD, HH:MM) in `timeZone` to the UTC instant it names.
 *
 * Ordinary case: a single instant maps to that wall clock; returned directly.
 *
 * Spring-forward gap (the wall clock is skipped, e.g. 2:30 AM on the day clocks jump from 2:00
 * to 3:00): per spec, returns the first valid instant after the gap — the moment the new offset
 * takes effect.
 *
 * Fall-back fold (the wall clock occurs twice, e.g. 1:30 AM on the day clocks fall back from
 * 2:00 to 1:00): per spec, returns the earlier of the two instants.
 */
function zonedTimeToUtc(timeZone: string, dateKey: string, time: string): Date {
  const [year, month, day] = keyParts(dateKey);
  const [hourStr, minuteStr] = time.split(":");
  const hour = Number(hourStr ?? 0);
  const minute = Number(minuteStr ?? 0);
  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const oneDayMs = 24 * 60 * 60 * 1000;
  const offsetBefore = offsetMinutesAt(timeZone, wallUtcMs - oneDayMs);
  const offsetAfter = offsetMinutesAt(timeZone, wallUtcMs + oneDayMs);

  if (offsetBefore === offsetAfter) {
    // No transition anywhere near this wall clock: the ordinary single-answer case.
    return new Date(wallUtcMs - offsetBefore * 60_000);
  }

  const candidateBefore = wallUtcMs - offsetBefore * 60_000;
  const candidateAfter = wallUtcMs - offsetAfter * 60_000;
  const beforeRoundTrips = offsetMinutesAt(timeZone, candidateBefore) === offsetBefore;
  const afterRoundTrips = offsetMinutesAt(timeZone, candidateAfter) === offsetAfter;

  if (beforeRoundTrips && afterRoundTrips) {
    // Fall-back fold: both offsets produce this wall clock. Use the earlier instant.
    return new Date(Math.min(candidateBefore, candidateAfter));
  }

  if (beforeRoundTrips !== afterRoundTrips) {
    // Exactly one offset actually produces this wall clock: the ordinary case, just close to a
    // transition that doesn't affect this particular instant.
    return new Date(beforeRoundTrips ? candidateBefore : candidateAfter);
  }

  // Spring-forward gap: neither offset round-trips, because this wall clock never occurred.
  // Binary-search the transition instant between the two candidates and return it — the first
  // valid instant after the gap.
  let lo = Math.min(candidateBefore, candidateAfter);
  let hi = Math.max(candidateBefore, candidateAfter);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetMinutesAt(timeZone, mid) === offsetBefore) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return new Date(hi);
}

const OFFSET_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function offsetMinutesAt(timeZone: string, instantMs: number): number {
  let dtf = OFFSET_FORMAT_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    OFFSET_FORMAT_CACHE.set(timeZone, dtf);
  }
  const parts = dtf.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some locales format midnight as 24:00
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - instantMs) / 60_000);
}
