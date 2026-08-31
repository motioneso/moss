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

/** #1869 slice 3A: why a wall clock cannot become a naive `.toISOString()` reinterpretation. */
export type StrictLocalWallClockErrorReason =
  | "invalid-syntax"
  | "invalid-timezone"
  | "dst-gap"
  | "dst-fold";

/**
 * Thrown by {@link strictLocalWallClockToInstant}. `reason` lets a caller (Food's write boundary,
 * #1869 slice 3B) map this to its own bounded validation error without parsing the message text.
 */
export class StrictLocalWallClockError extends Error {
  readonly reason: StrictLocalWallClockErrorReason;

  constructor(reason: StrictLocalWallClockErrorReason, message: string) {
    super(message);
    this.name = "StrictLocalWallClockError";
    this.reason = reason;
  }
}

interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall-clock parts `instant` is observed as in `timeZone`, for equality checks against input. */
function localWallClockParts(instant: Date, timeZone: string): WallClockParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second"))
  };
}

function wallClockPartsEqual(a: WallClockParts, b: WallClockParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

const LOCAL_WALL_CLOCK_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Converts an offset-less local wall-clock date-time (`YYYY-MM-DDTHH:mm[:ss[.sss]]`, no `Z` and no
 * numeric offset) to the exact UTC instant it denotes in `timeZone`.
 *
 * #1869: this is the one canonical version of the conversion Food's write boundary needs, so a
 * second module never re-derives it slightly differently. An offset-bearing timestamp is already
 * unambiguous and does not go through this function — parse it directly and never reinterpret it
 * against a time zone.
 *
 * Strict on purpose: silently shifting an ambiguous or nonexistent wall-clock time recreates the
 * class of corruption this exists to fix. Two situations are rejected rather than guessed at:
 *
 * - A spring-forward gap (e.g. 2:30am on the day a zone's clocks jump from 2am to 3am) denotes no
 *   instant at all.
 * - A fall-back fold (e.g. 1:30am on the day a zone's clocks repeat 1am-2am) denotes two different
 *   instants an hour apart.
 *
 * Both cases throw a {@link StrictLocalWallClockError}; the caller must supply an explicit offset
 * instead of calling this function.
 *
 * Detection samples the zone's offset a day either side of the wall-clock moment — far enough from
 * any single transition to land on the settled offset on each side — builds the (at most two)
 * resulting candidate instants, and keeps only the ones that round-trip back through
 * `Intl.DateTimeFormat` to the exact wall clock requested. Exactly one surviving candidate is the
 * valid, unambiguous answer.
 */
export function strictLocalWallClockToInstant(localDateTime: string, timeZone: string): Date {
  const match = LOCAL_WALL_CLOCK_PATTERN.exec(localDateTime);
  if (!match) {
    throw new StrictLocalWallClockError(
      "invalid-syntax",
      `strictLocalWallClockToInstant: expected an offset-less local date-time like ` +
        `"YYYY-MM-DDTHH:mm:ss", got ${JSON.stringify(localDateTime)}`
    );
  }
  if (!isValidTimeZone(timeZone)) {
    throw new StrictLocalWallClockError(
      "invalid-timezone",
      `strictLocalWallClockToInstant: "${timeZone}" is not a recognised time zone`
    );
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fractionStr] = match;
  const wall: WallClockParts = {
    year: Number(yearStr),
    month: Number(monthStr),
    day: Number(dayStr),
    hour: Number(hourStr),
    minute: Number(minuteStr),
    second: secondStr === undefined ? 0 : Number(secondStr)
  };
  const millisecond =
    fractionStr === undefined ? 0 : Number(fractionStr.padEnd(3, "0").slice(0, 3));

  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    millisecond
  );
  const roundTrip = new Date(wallAsUtc);
  if (
    roundTrip.getUTCFullYear() !== wall.year ||
    roundTrip.getUTCMonth() !== wall.month - 1 ||
    roundTrip.getUTCDate() !== wall.day ||
    roundTrip.getUTCHours() !== wall.hour ||
    roundTrip.getUTCMinutes() !== wall.minute ||
    roundTrip.getUTCSeconds() !== wall.second
  ) {
    // Date.UTC silently rolls a nonexistent calendar date (month 13, day 32, ...) into the next
    // one instead of failing, so the round trip above is the only way to catch it.
    throw new StrictLocalWallClockError(
      "invalid-syntax",
      `strictLocalWallClockToInstant: "${localDateTime}" is not a valid calendar date-time`
    );
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const settledOffsets = new Set([
    timeZoneOffsetMinutes(new Date(wallAsUtc - DAY_MS), timeZone),
    timeZoneOffsetMinutes(new Date(wallAsUtc + DAY_MS), timeZone)
  ]);

  const candidates = new Set<number>();
  for (const offsetMinutes of settledOffsets) {
    const candidateInstantMs = wallAsUtc - offsetMinutes * 60_000;
    if (wallClockPartsEqual(localWallClockParts(new Date(candidateInstantMs), timeZone), wall)) {
      candidates.add(candidateInstantMs);
    }
  }

  if (candidates.size === 0) {
    throw new StrictLocalWallClockError(
      "dst-gap",
      `strictLocalWallClockToInstant: "${localDateTime}" does not exist in "${timeZone}" ` +
        `(it falls in a spring-forward gap); supply an explicit offset instead`
    );
  }
  if (candidates.size > 1) {
    throw new StrictLocalWallClockError(
      "dst-fold",
      `strictLocalWallClockToInstant: "${localDateTime}" is ambiguous in "${timeZone}" ` +
        `(it falls in a fall-back fold); supply an explicit offset instead`
    );
  }

  return new Date([...candidates][0] as number);
}
