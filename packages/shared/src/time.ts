/**
 * Single source of truth for timezone-aware day/time derivation (#579, #636).
 *
 * Pure and node-free so it lives in the browser-bundled @moss/shared package —
 * also consumed by Node server packages (chat, tasks, wellness) that need the
 * same Intl-only logic without duplicating it.
 *
 * `localDay` is the only sanctioned way to derive a calendar day from an instant.
 * Never compute a day with `.slice(0,10)` on a UTC ISO string, `Date.UTC(...)` day
 * boundaries, or `getUTC*` date parts — those derive the UTC day, not the user's.
 */

type DateInput = string | number | Date;

function toDate(input: DateInput): Date | null {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** On unparseable input, preserve the caller's defensive behaviour: echo a raw string, else "". */
function rawFallback(input: DateInput): string {
  return typeof input === "string" ? input : "";
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(headerTz?: string | null, storedTz?: string | null): string {
  const header = headerTz?.trim();
  if (header && isValidTimeZone(header)) return header;
  const stored = storedTz?.trim();
  if (stored && isValidTimeZone(stored)) return stored;
  return "UTC";
}

const DAY_KEY_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
};

/**
 * Calendar date key (`YYYY-MM-DD`) for an instant *as observed in the given timezone*.
 * Locale-independent (en-CA): a machine key for day comparison / "today" / streaks,
 * never a display string. Falls back to the ambient zone if `timeZone` is invalid.
 */
export function localDay(input: DateInput, timeZone?: string): string {
  const date = toDate(input);
  if (!date) return rawFallback(input);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, ...DAY_KEY_OPTS }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", DAY_KEY_OPTS).format(date);
  }
}

/**
 * Format an instant in the given IANA timezone — the only sanctioned formatter for
 * user-facing date/time display. Returns a raw-string echo (or "") on an
 * unparseable instant or an invalid timezone/locale; never throws.
 */
export function formatInZone(
  input: DateInput,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
  locale?: string
): string {
  const date = toDate(input);
  if (!date) return rawFallback(input);
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(date);
  } catch {
    return rawFallback(input);
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface DayCoverageEvent {
  readonly startsAt: string;
  readonly endsAt?: string | null;
  readonly allDay?: boolean;
}

/**
 * Whether an event falls on the calendar day `dayKey` (`YYYY-MM-DD`) for a viewer in `timeZone`.
 *
 * All-day events are stored as UTC midnights with an exclusive end date, so they are plain
 * calendar dates and are compared as such. Timed events start on the viewer's local day.
 */
export function eventCoversDay(
  event: DayCoverageEvent,
  dayKey: string,
  timeZone?: string
): boolean {
  if (event.allDay !== true) return localDay(event.startsAt, timeZone) === dayKey;
  const start = event.startsAt.slice(0, 10);
  if (!DATE_ONLY.test(start)) return false;
  const end = typeof event.endsAt === "string" ? event.endsAt.slice(0, 10) : "";
  return DATE_ONLY.test(end) && end > start ? start <= dayKey && dayKey < end : start === dayKey;
}
