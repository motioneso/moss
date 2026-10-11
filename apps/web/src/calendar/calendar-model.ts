import {
  formatLocaleDate,
  formatLocaleTime,
  localDay,
  type CalendarEventDto,
  type LocaleSettingsDto
} from "@moss/shared";

import { zonedClockMinutes } from "../locale/locale-format.js";

export type CalendarView = "day" | "week" | "month";

export interface CalendarViewEvent {
  readonly id: string;
  readonly title: string;
  readonly kind: "block" | "event";
  readonly allDay: boolean;
  readonly startMin: number;
  readonly endMin: number;
  readonly date: Date;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly where: string | null;
  readonly attendeeCount: number;
  readonly status: string | null;
  // assigned by packDay
  _col?: number;
  _cols?: number;
}

export const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DOW_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;
export const MONTH_NAMES = [
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
] as const;

// Calendar days are plain dates held as UTC-midnight `Date`s and read with UTC getters,
// so day math never depends on the browser's zone. Instants become plain dates and
// clock minutes in the person's saved timezone.

export function plainDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

export function addDays(date: Date, days: number): Date {
  return plainDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
}

function plainDateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return plainDate(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** The plain date an instant falls on in `timeZone`. */
export function plainDateOf(instant: Date, timeZone: string): Date {
  return plainDateFromKey(localDay(instant, timeZone));
}

export function todayIn(timeZone: string): Date {
  return plainDateOf(new Date(), timeZone);
}

function clockMinutes(instant: Date, timeZone: string): number {
  return zonedClockMinutes(instant, timeZone) ?? 0;
}

// Wall-clock values carry no zone, so they format in UTC on a fixed day.
function clockInstant(min: number): number {
  return Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60);
}

const WALL_CLOCK = "UTC";

export function fmtTime(min: number, locale: LocaleSettingsDto): string {
  const wall = { ...locale, timezone: WALL_CLOCK };
  return locale.dateFormat === "12" && min % 60 === 0
    ? formatLocaleTime(clockInstant(min), wall, { hour: "numeric" })
    : formatLocaleTime(clockInstant(min), wall);
}

export function fmtHour(h: number, locale: LocaleSettingsDto): string {
  const wall = { ...locale, timezone: WALL_CLOCK };
  return locale.dateFormat === "12"
    ? formatLocaleTime(clockInstant(h * 60), wall, { hour: "numeric" })
    : formatLocaleTime(clockInstant(h * 60), wall, { hour: "2-digit", minute: "2-digit" });
}

export function fmtDur(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return m + " min";
  return h + " hr" + (m ? " " + m + " min" : "");
}

export function fmtDateLabel(date: Date, locale: LocaleSettingsDto): string {
  return formatLocaleDate(
    date,
    { ...locale, timezone: WALL_CLOCK },
    { weekday: "long", month: "long", day: "numeric" }
  );
}

export function isToday(date: Date, timeZone: string): boolean {
  return dayKey(date) === localDay(new Date(), timeZone);
}

export function nowMin(timeZone: string): number {
  return clockMinutes(new Date(), timeZone);
}

/** `YYYY-MM-DD` key of a plain date. */
export function dayKey(date: Date): string {
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${m}-${d}`;
}

export function dtoToViewEvent(dto: CalendarEventDto, timeZone: string): CalendarViewEvent | null {
  const startsAt = new Date(dto.startsAt);
  if (Number.isNaN(startsAt.getTime())) return null;
  const endsAt = new Date(dto.endsAt);
  const startMin = clockMinutes(startsAt, timeZone);
  const endMin = Number.isNaN(endsAt.getTime()) ? startMin + 60 : clockMinutes(endsAt, timeZone);

  // All-day events sync as UTC midnights (connectors sync-jobs.ts), so their UTC date
  // is already the plain date. Timed events take the person's day of their start.
  const date = dto.allDay
    ? plainDate(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate())
    : plainDateOf(startsAt, timeZone);

  return {
    id: dto.id,
    title: dto.title,
    kind: dto.isMossBlock ? "block" : "event",
    allDay: dto.allDay,
    startMin,
    endMin,
    date,
    startsAt,
    endsAt,
    where: dto.location,
    attendeeCount: dto.attendeeCount,
    status: dto.status
  };
}

function addToBucket(
  map: Map<string, CalendarViewEvent[]>,
  day: Date,
  event: CalendarViewEvent
): void {
  const key = dayKey(day);
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(event);
  } else {
    map.set(key, [event]);
  }
}

// Buckets each event on every day it covers in the person's timezone. All-day ends
// are exclusive. Timed events crossing midnight get one clipped segment per day;
// segments keep the event id and true start/end instants.
export function groupEventsByDay(
  events: readonly CalendarViewEvent[],
  timeZone: string
): Map<string, CalendarViewEvent[]> {
  const map = new Map<string, CalendarViewEvent[]>();
  for (const e of events) {
    const first = e.date;
    const endMs = e.endsAt.getTime();
    if (Number.isNaN(endMs) || endMs <= e.startsAt.getTime()) {
      addToBucket(map, first, e);
      continue;
    }

    if (e.allDay) {
      const end = plainDate(
        e.endsAt.getUTCFullYear(),
        e.endsAt.getUTCMonth(),
        e.endsAt.getUTCDate()
      );
      let day = first;
      do {
        addToBucket(map, day, day === first ? e : { ...e, date: day });
        day = addDays(day, 1);
      } while (day < end);
      continue;
    }

    const lastMidnight = plainDateOf(e.endsAt, timeZone);
    const last = e.endMin === 0 && lastMidnight > first ? addDays(lastMidnight, -1) : lastMidnight;
    if (last <= first) {
      // A timed event ending exactly at midnight runs to the end of its day.
      addToBucket(map, first, e.endMin === 0 ? { ...e, endMin: 1440 } : e);
      continue;
    }
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const isFirst = day.getTime() === first.getTime();
      const isLast = day.getTime() === last.getTime();
      addToBucket(map, day, {
        ...e,
        date: isFirst ? e.date : day,
        startMin: isFirst ? e.startMin : 0,
        endMin: isLast ? (e.endMin === 0 ? 1440 : e.endMin) : 1440
      });
    }
  }
  return map;
}

export function buildWeekDays(cursor: Date, workWeek: boolean): Date[] {
  const dow = cursor.getUTCDay();
  const days: Date[] = [];
  const start = workWeek ? 1 : 0;
  const end = workWeek ? 6 : 7;
  for (let i = start; i < end; i++) {
    days.push(addDays(cursor, i - dow));
  }
  return days;
}

export function buildMonthCells(cursor: Date): Date[] {
  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();
  const firstDow = plainDate(year, month, 1).getUTCDay();
  const cells: Date[] = [];
  for (let i = -firstDow; i < 42 - firstDow; i++) {
    cells.push(plainDate(year, month, 1 + i));
  }
  const lastWeek = cells.slice(35);
  if (lastWeek.every((d) => d.getUTCMonth() !== month)) {
    return cells.slice(0, 35);
  }
  return cells;
}

export function navigateCursor(cursor: Date, view: CalendarView, dir: -1 | 1): Date {
  if (view === "day") return addDays(cursor, dir);
  if (view === "week") return addDays(cursor, dir * 7);
  const y = cursor.getUTCFullYear();
  const m = cursor.getUTCMonth() + dir;
  const lastDay = plainDate(y, m + 1, 0).getUTCDate();
  return plainDate(y, m, Math.min(cursor.getUTCDate(), lastDay));
}

export function rangeLabel(cursor: Date, view: CalendarView, days: Date[]): string {
  if (view === "day") {
    return (
      DOW_LONG[cursor.getUTCDay()] +
      ", " +
      MONTH_NAMES[cursor.getUTCMonth()] +
      " " +
      cursor.getUTCDate()
    );
  }
  if (view === "week" && days.length >= 2) {
    const a = days[0]!;
    const b = days[days.length - 1]!;
    if (a.getUTCMonth() === b.getUTCMonth()) {
      return MONTH_NAMES[a.getUTCMonth()] + " " + a.getUTCDate() + " – " + b.getUTCDate();
    }
    return (
      (MONTH_NAMES[a.getUTCMonth()] ?? "").slice(0, 3) +
      " " +
      a.getUTCDate() +
      " – " +
      (MONTH_NAMES[b.getUTCMonth()] ?? "").slice(0, 3) +
      " " +
      b.getUTCDate()
    );
  }
  return MONTH_NAMES[cursor.getUTCMonth()] + " " + cursor.getUTCFullYear();
}

export function packDay(evs: CalendarViewEvent[]): CalendarViewEvent[] {
  const items = evs
    .filter((e) => !e.allDay)
    .slice()
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  let cluster: CalendarViewEvent[] = [];
  let clusterEnd = -1;

  function flush() {
    if (!cluster.length) return;
    const colsEnd: number[] = [];
    for (const e of cluster) {
      let placed = false;
      for (let i = 0; i < colsEnd.length; i++) {
        if (e.startMin >= colsEnd[i]!) {
          e._col = i;
          colsEnd[i] = e.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e._col = colsEnd.length;
        colsEnd.push(e.endMin);
      }
    }
    for (const e of cluster) {
      e._cols = colsEnd.length;
    }
    cluster = [];
    clusterEnd = -1;
  }

  for (const e of items) {
    if (cluster.length && e.startMin >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  flush();
  return items;
}

// Legacy `jarvis.cal.*` keys are read once and migrated to their `moss.cal.*`
// replacements so a browser that persisted state before the rename doesn't
// silently reset to defaults. New writes only ever touch the new key.
function migrateLegacyKey(oldKey: string, newKey: string): string | null {
  const current = localStorage.getItem(newKey);
  if (current !== null) return current;
  const legacy = localStorage.getItem(oldKey);
  if (legacy !== null) {
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(oldKey);
  }
  return legacy;
}

export function loadPersistedView(): CalendarView {
  const v = migrateLegacyKey("jarvis.cal.view", "moss.cal.view");
  return v === "week" || v === "month" ? v : "day";
}

/** The saved plain date, or null so the page can start on today in the person's zone. */
export function loadPersistedCursor(): Date | null {
  const s = migrateLegacyKey("jarvis.cal.cursor", "moss.cal.cursor");
  if (s) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return plainDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }
  return null;
}

export function loadPersistedWorkWeek(): boolean {
  return migrateLegacyKey("jarvis.cal.workweek", "moss.cal.workweek") === "1";
}

// Real first date, plus the real last date when the event spans several days.
export function dateRangeLabel(event: CalendarViewEvent, locale: LocaleSettingsDto): string {
  if (event.allDay) {
    const first = plainDate(
      event.startsAt.getUTCFullYear(),
      event.startsAt.getUTCMonth(),
      event.startsAt.getUTCDate()
    );
    // All-day end is exclusive and UTC-midnight anchored.
    const last = plainDate(
      event.endsAt.getUTCFullYear(),
      event.endsAt.getUTCMonth(),
      event.endsAt.getUTCDate() - 1
    );
    return last > first
      ? fmtDateLabel(first, locale) + " – " + fmtDateLabel(last, locale)
      : fmtDateLabel(first, locale);
  }
  const first = plainDateOf(event.startsAt, locale.timezone);
  const endsAtMidnight =
    clockMinutes(event.endsAt, locale.timezone) === 0 && event.endsAt > event.startsAt;
  const endDay = plainDateOf(event.endsAt, locale.timezone);
  const last = endsAtMidnight ? addDays(endDay, -1) : endDay;
  return last <= first
    ? fmtDateLabel(first, locale)
    : fmtDateLabel(first, locale) + " – " + fmtDateLabel(last, locale);
}
