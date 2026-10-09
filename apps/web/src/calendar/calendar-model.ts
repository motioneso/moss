import type { CalendarEventDto } from "@moss/shared";

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

export function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return h12 + (m ? ":" + String(m).padStart(2, "0") : "") + " " + ap;
}

export function fmtHour(h: number): string {
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return h12 + " " + ap;
}

export function fmtDur(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return m + " min";
  return h + " hr" + (m ? " " + m + " min" : "");
}

export function fmtDateLabel(date: Date): string {
  return DOW_LONG[date.getDay()] + ", " + MONTH_NAMES[date.getMonth()] + " " + date.getDate();
}

export function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function nowMin(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dtoToViewEvent(dto: CalendarEventDto): CalendarViewEvent | null {
  const startsAt = new Date(dto.startsAt);
  if (Number.isNaN(startsAt.getTime())) return null;
  const endsAt = new Date(dto.endsAt);
  const startMin = startsAt.getHours() * 60 + startsAt.getMinutes();
  const endMin = Number.isNaN(endsAt.getTime())
    ? startMin + 60
    : endsAt.getHours() * 60 + endsAt.getMinutes();

  // `date` is the calendar day an event belongs to — it drives day grouping
  // (groupEventsByDay → dayKey, read with LOCAL components) and the peek's date
  // label. All-day events are synced as UTC-midnight (connectors sync-jobs.ts), so
  // reading that instant with local components shifts them into the previous day in
  // western timezones. Anchor all-day events to a local Date built from their UTC
  // date-only components so every local-component consumer buckets them correctly;
  // timed events keep the local day of their start instant.
  const date = dto.allDay
    ? new Date(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate())
    : startsAt;

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

// Buckets each event on every local day it covers. All-day ends are exclusive.
// Timed events crossing midnight get one clipped segment per day; segments keep
// the event id and true start/end instants.
export function groupEventsByDay(
  events: readonly CalendarViewEvent[]
): Map<string, CalendarViewEvent[]> {
  const map = new Map<string, CalendarViewEvent[]>();
  for (const e of events) {
    const first = new Date(e.date.getFullYear(), e.date.getMonth(), e.date.getDate());
    const endMs = e.endsAt.getTime();
    if (Number.isNaN(endMs) || endMs <= e.startsAt.getTime()) {
      addToBucket(map, first, e);
      continue;
    }

    if (e.allDay) {
      const end = new Date(
        e.endsAt.getUTCFullYear(),
        e.endsAt.getUTCMonth(),
        e.endsAt.getUTCDate()
      );
      let day = first;
      do {
        addToBucket(map, day, day === first ? e : { ...e, date: day });
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      } while (day < end);
      continue;
    }

    const lastMidnight = new Date(e.endsAt.getFullYear(), e.endsAt.getMonth(), e.endsAt.getDate());
    const last =
      e.endMin === 0 && lastMidnight > first
        ? new Date(lastMidnight.getFullYear(), lastMidnight.getMonth(), lastMidnight.getDate() - 1)
        : lastMidnight;
    if (last <= first) {
      // A timed event ending exactly at local midnight runs to the end of its day.
      addToBucket(map, first, e.endMin === 0 ? { ...e, endMin: 1440 } : e);
      continue;
    }
    for (
      let day = first;
      day <= last;
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    ) {
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
  const dow = cursor.getDay();
  const days: Date[] = [];
  const start = workWeek ? 1 : 0;
  const end = workWeek ? 6 : 7;
  for (let i = start; i < end; i++) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() - dow + i);
    days.push(d);
  }
  return days;
}

export function buildMonthCells(cursor: Date): Date[] {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const cells: Date[] = [];
  for (let i = -firstDow; i < 42 - firstDow; i++) {
    cells.push(new Date(year, month, 1 + i));
  }
  const lastWeek = cells.slice(35);
  if (lastWeek.every((d) => d.getMonth() !== month)) {
    return cells.slice(0, 35);
  }
  return cells;
}

export function navigateCursor(cursor: Date, view: CalendarView, dir: -1 | 1): Date {
  const d = new Date(cursor);
  if (view === "day") {
    d.setDate(d.getDate() + dir);
  } else if (view === "week") {
    d.setDate(d.getDate() + dir * 7);
  } else {
    d.setMonth(d.getMonth() + dir);
  }
  return d;
}

export function rangeLabel(cursor: Date, view: CalendarView, days: Date[]): string {
  if (view === "day") {
    return (
      DOW_LONG[cursor.getDay()] + ", " + MONTH_NAMES[cursor.getMonth()] + " " + cursor.getDate()
    );
  }
  if (view === "week" && days.length >= 2) {
    const a = days[0]!;
    const b = days[days.length - 1]!;
    if (a.getMonth() === b.getMonth()) {
      return MONTH_NAMES[a.getMonth()] + " " + a.getDate() + " – " + b.getDate();
    }
    return (
      (MONTH_NAMES[a.getMonth()] ?? "").slice(0, 3) +
      " " +
      a.getDate() +
      " – " +
      (MONTH_NAMES[b.getMonth()] ?? "").slice(0, 3) +
      " " +
      b.getDate()
    );
  }
  return MONTH_NAMES[cursor.getMonth()] + " " + cursor.getFullYear();
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

export function loadPersistedCursor(): Date {
  const s = migrateLegacyKey("jarvis.cal.cursor", "moss.cal.cursor");
  if (s) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function loadPersistedWorkWeek(): boolean {
  return migrateLegacyKey("jarvis.cal.workweek", "moss.cal.workweek") === "1";
}
