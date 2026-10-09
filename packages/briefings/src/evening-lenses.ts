// PURE evening lens math (no I/O, no ambient dates — `now` is always injected).
// Day comparisons use en-CA (YYYY-MM-DD) keys in the user's IANA tz so key ordering
// is lexicographic and boundary behavior (23:59 vs 00:01, DST) is exact.

export interface EveningTaskItem {
  readonly id: string;
  readonly title: string;
  readonly doAt: string | null;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
}

export interface EveningTaskLenses {
  readonly completedToday: EveningTaskItem[];
  readonly slipped: EveningTaskItem[];
  readonly carryingForward: EveningTaskItem[];
}

export function localDayKey(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  } catch {
    // Unknown tz — fail closed (caller treats the item as out of window).
    return null;
  }
}

/** The next local day after `now`. Probes past 24h so a 25h fall-back DST day still lands tomorrow. */
function nextLocalDayKey(now: Date, timeZone: string): string | null {
  const today = localDayKey(now, timeZone);
  if (today === null) return null;
  for (const hours of [24, 26, 30]) {
    const key = localDayKey(new Date(now.getTime() + hours * 3_600_000), timeZone);
    if (key !== null && key !== today) return key;
  }
  return null;
}

function toItem(raw: Record<string, unknown>): EveningTaskItem | null {
  const title = typeof raw.title === "string" ? raw.title : "";
  if (!title) return null;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    title,
    doAt: typeof raw.doAt === "string" ? raw.doAt : null,
    dueAt: typeof raw.dueAt === "string" ? raw.dueAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null
  };
}

export function partitionEveningTasks(args: {
  readonly completedItems: readonly Record<string, unknown>[];
  readonly openItems: readonly Record<string, unknown>[];
  readonly now: Date;
  readonly timeZone: string;
}): EveningTaskLenses {
  const todayKey = localDayKey(args.now, args.timeZone);
  const completedToday: EveningTaskItem[] = [];
  const slipped: EveningTaskItem[] = [];
  const carryingForward: EveningTaskItem[] = [];
  if (todayKey === null) {
    return { completedToday, slipped, carryingForward };
  }
  for (const raw of args.completedItems) {
    const item = toItem(raw);
    // Gather already bounds completedAt to today; keep the guard so the partition is
    // safe on unfiltered input too (unit tests exercise it directly).
    if (item && localDayKey(item.completedAt, args.timeZone) === todayKey) {
      completedToday.push(item);
    }
  }
  for (const raw of args.openItems) {
    const item = toItem(raw);
    if (!item) continue;
    const planKeys = [
      localDayKey(item.doAt, args.timeZone),
      localDayKey(item.dueAt, args.timeZone)
    ].filter((k): k is string => k !== null);
    if (planKeys.length === 0) continue;
    if (planKeys.some((k) => k === todayKey)) {
      // Planned for today and still open → it slipped.
      slipped.push(item);
    } else if (planKeys.some((k) => k < todayKey)) {
      // Overdue from an earlier day → rolls forward.
      carryingForward.push(item);
    }
  }
  return { completedToday, slipped, carryingForward };
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// All-day rows are UTC midnights with an exclusive end date, so they compare
// as calendar dates, never as local instants.
function allDayCoversDay(item: Record<string, unknown>, startsAt: string, dayKey: string): boolean {
  const start = startsAt.slice(0, 10);
  if (!DATE_KEY.test(start)) return false;
  const end = typeof item.endsAt === "string" ? item.endsAt.slice(0, 10) : "";
  return DATE_KEY.test(end) && end > start ? start <= dayKey && dayKey < end : start === dayKey;
}

export function filterEveningCalendar(
  items: readonly Record<string, unknown>[],
  now: Date,
  timeZone: string
): Record<string, unknown>[] {
  const todayKey = localDayKey(now, timeZone);
  const tomorrowKey = nextLocalDayKey(now, timeZone);
  if (todayKey === null || tomorrowKey === null) return [];
  return items.filter((item) => {
    const startsAt = item.startsAt;
    if (typeof startsAt !== "string") return false;
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) return false;
    if (item.allDay === true) return allDayCoversDay(item, startsAt, tomorrowKey);
    const key = localDayKey(startsAt, timeZone);
    if (key === tomorrowKey) return true;
    return key === todayKey && start.getTime() > now.getTime();
  });
}
