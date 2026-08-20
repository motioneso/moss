/**
 * Local-day arithmetic for modules that record dated user data.
 *
 * #1723 item 1: Food was the first real external module, and it had to write all of this itself
 * because the SDK offered nothing. The next module would have copied it, and the two copies would
 * have drifted — so it lives here now and Food imports it.
 *
 * The rule these helpers exist to enforce: **a user's day is not the server's day.** Never derive a
 * calendar date with `.slice(0, 10)` on a UTC ISO string or from `getUTC*` parts. Both give the
 * server's idea of the date, so a meal logged at 8pm in Los Angeles lands on tomorrow, and the user
 * sees an empty day and a mystery entry. Every function here takes an explicit time zone.
 *
 * Kept free of any `node:*` import so the barrel stays browser-safe (see index.ts and
 * tests/unit/module-sdk-barrel-browser-safety.test.ts). `Intl` is available in both runtimes.
 */

/** True when `timeZone` is an IANA zone this runtime recognises. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Falls back to UTC rather than throwing, matching `resolveTimeZone` in packages/shared/src/time.ts.
 * A module handling a request with a malformed zone header should still answer, with a day that is
 * merely wrong-for-this-user rather than an error.
 */
function safeZone(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/**
 * The calendar date (`YYYY-MM-DD`) on which `date` falls as observed in `timeZone`.
 *
 * `en-CA` is not a stylistic choice — it is the locale whose short date format is already
 * ISO-ordered, so the result needs no reassembly and cannot be reordered by a runtime's locale
 * data.
 */
export function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/** The user's current calendar date in `timeZone`. */
export function todayLocalDayKey(timeZone: string, now: Date = new Date()): string {
  return localDayKey(now, timeZone);
}

/**
 * Minutes EAST of UTC for the instant `date`, observed in `timeZone`.
 *
 * Computed per instant rather than per zone, so a record created either side of a daylight-saving
 * transition gets the offset that was actually in force at the time.
 */
export function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const zone = safeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second"))
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

/**
 * The calendar day a record should be pinned to, plus the offset in force at that instant.
 *
 * Modules are expected to persist BOTH and never recompute the day at read time. If the day were
 * derived on read, changing the user's configured time zone would silently reshuffle which day
 * every past record belongs to — a record they entered on Tuesday would move to Monday.
 */
export function resolveLocalDay(
  instant: Date,
  timeZone: string
): { readonly localDate: string; readonly timezoneOffsetMinutes: number } {
  const zone = safeZone(timeZone);
  return {
    localDate: localDayKey(instant, zone),
    timezoneOffsetMinutes: timeZoneOffsetMinutes(instant, zone)
  };
}

/**
 * The half-open UTC instant range `[start, end)` covering the local day `localDate` in `timeZone`.
 *
 * Half-open, not inclusive: an inclusive end has to be expressed as "the last millisecond of the
 * day", which silently drops anything recorded in the final fraction of a second and gets the
 * boundary wrong at a DST transition. Query with `>= start AND < end`.
 *
 * A day is not always 24 hours long. Where a zone springs forward, the day is 23 hours; where it
 * falls back, 25. This resolves each boundary against the offset actually in force there rather
 * than adding a fixed day to the start.
 *
 * Throws on a malformed `localDate` rather than guessing, because a bad date here silently returns
 * the wrong records instead of failing.
 */
export function localDayRange(
  localDate: string,
  timeZone: string
): { readonly start: Date; readonly end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error(`localDayRange: expected a YYYY-MM-DD local date, got "${localDate}"`);
  }
  const zone = safeZone(timeZone);
  return {
    start: localMidnightUtc(localDate, zone),
    end: localMidnightUtc(addLocalDays(localDate, 1), zone)
  };
}

/**
 * The UTC instant at which the local day `localDate` begins in `timeZone`.
 *
 * Two passes, not one. Treating the local wall-clock midnight as if it were UTC and subtracting the
 * offset is only correct when that offset is the one in force at the answer — which is exactly what
 * is not known yet. The first pass gets close enough to land inside the right day; the second pass
 * re-reads the offset there and corrects. This is what makes DST-transition days come out right.
 */
function localMidnightUtc(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = new Date(
    wallClockAsUtc - timeZoneOffsetMinutes(new Date(wallClockAsUtc), timeZone) * 60_000
  );
  return new Date(wallClockAsUtc - timeZoneOffsetMinutes(firstGuess, timeZone) * 60_000);
}

/** Adds whole calendar days to a `YYYY-MM-DD` key. Pure string/UTC arithmetic — no zone involved. */
export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}
