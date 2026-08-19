import { createHash } from "node:crypto";
import { resolveMossEnv } from "@moss/db";

/**
 * Configured default timezone for part-of-day band resolution + all-day-interval detection when
 * no per-request `ToolContext.localTimezone` is available. Single source of truth shared by
 * tools.ts (band resolution) and calendar-write-impl.ts (all-day busy-interval filtering).
 */
export const DEFAULT_TIMEZONE = resolveMossEnv(process.env, "JARVIS_DEFAULT_TZ") ?? "America/New_York";

export type PartOfDay = "morning" | "afternoon" | "evening";

export interface FocusBlockInput {
  readonly date?: string; // ISO yyyy-mm-dd, local
  readonly partOfDay?: PartOfDay;
  readonly start?: string; // ISO datetime
  readonly durationMinutes?: number;
  readonly title?: string;
}

export interface ResolvedWindow {
  readonly start: Date;
  readonly end: Date;
  readonly durationMinutes: number;
  readonly title: string;
}

export interface SlotChoice {
  readonly start: Date;
  readonly end: Date;
  readonly shifted: boolean;
  readonly conflict: "none" | "shifted" | "no-clear-slot";
}

const MIN_DURATION = 15;
const MAX_DURATION = 480;
const DEFAULT_DURATION = 120;
const DEFAULT_TITLE = "Focus time";

// Local-time part-of-day bands [startHour, endHour) in the calendar's timezone.
const BANDS: Record<PartOfDay, { startHour: number; endHour: number }> = {
  morning: { startHour: 9, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 21 }
};

function clampDuration(d: number | undefined): number {
  const v = typeof d === "number" && Number.isFinite(d) ? Math.trunc(d) : DEFAULT_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, v));
}

/**
 * Returns the UTC offset (minutes) of `tz` at instant `at`, by comparing the wall-clock
 * the zone reports against the same fields read as UTC. Positive = east of UTC.
 */
function tzOffsetMinutes(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * Splits a yyyy-mm-dd string into numeric [year, month, day]. Returns a fixed-length
 * tuple of `number` (not `number | undefined`) so callers satisfy noUncheckedIndexedAccess;
 * missing parts coerce to NaN, which the calendar-date round-trip check in resolveWindow rejects.
 */
function parseDateParts(dateIso: string): [number, number, number] {
  const parts = dateIso.split("-");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Builds the UTC Date for wall-clock yyyy-mm-dd HH:00 local in `tz`. */
function localWallClockToUtc(dateIso: string, hour: number, tz: string): Date {
  const [y, m, d] = parseDateParts(dateIso);
  // First approximation assuming UTC, then correct by the zone offset at that instant.
  const naiveUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  const offset = tzOffsetMinutes(tz, new Date(naiveUtc));
  return new Date(naiveUtc - offset * 60_000);
}

/** yyyy-mm-dd of `at` in `tz`. */
function localDateString(at: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return dtf.format(at); // en-CA yields yyyy-mm-dd
}

function addDaysLocal(dateIso: string, days: number): string {
  const [y, m, d] = parseDateParts(dateIso);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FocusBlockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FocusBlockInputError";
  }
}

export function resolveWindow(input: FocusBlockInput, now: Date, tz: string): ResolvedWindow {
  const durationMinutes = clampDuration(input.durationMinutes);
  const title = input.title?.trim() ? input.title.trim() : DEFAULT_TITLE;

  // Handler-side validation: the gateway validator does NOT enforce format/pattern (issue #133),
  // so reject a malformed start/date HERE — before any approval card or Google call (Codex MED #5).
  if (input.start) {
    const start = new Date(input.start);
    if (Number.isNaN(start.getTime())) {
      throw new FocusBlockInputError("start must be a valid RFC3339 datetime");
    }
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return { start, end, durationMinutes, title };
  }

  if (input.date !== undefined) {
    if (!DATE_RE.test(input.date)) {
      throw new FocusBlockInputError("date must be in yyyy-mm-dd format");
    }
    // DATE_RE only checks shape; Date.UTC NORMALIZES overflow (2026-99-99 → a real later date),
    // so reject any date whose components don't ROUND-TRIP (Codex LOW #20).
    const [y, m, d] = parseDateParts(input.date);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
      throw new FocusBlockInputError("date is not a valid calendar date");
    }
  }
  const part = input.partOfDay ?? "morning";
  const band = BANDS[part];
  const dateIso = input.date ?? addDaysLocal(localDateString(now, tz), 1);
  const start = localWallClockToUtc(dateIso, band.startHour, tz);
  const end = localWallClockToUtc(dateIso, band.endHour, tz);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new FocusBlockInputError("date is not a valid calendar date");
  }
  return { start, end, durationMinutes, title };
}

/**
 * A deterministic Google Calendar event id for an approved focus block. Idempotency floor for
 * the outbound write: a retry of the SAME approved proposal (e.g. lost insert response → user
 * re-approves the identical block) reuses this id, so Google returns 409 Conflict instead of
 * creating a duplicate event.
 *
 * CRITICAL: the key is the ORIGINAL APPROVED PROPOSAL — the requested search window
 * (windowStart..windowEnd), the requested durationMinutes, the actor, and the title — NOT the
 * post-freeBusy chosen slot. Keying on the chosen slot would NOT be retry-safe: after a lost
 * insert response the already-created block shows as busy, so the retry's freeBusy shifts the
 * slot, yielding a DIFFERENT id and a second event (Codex HIGH round 2). The requested window is
 * invariant across retries, so the id is stable regardless of how the slot is shifted.
 *
 * Google event ids must be base32hex (chars a-v + 0-9), length 5..1024 — we sha256 the canonical
 * key and map each byte's low 5 bits to base32hex, producing a 35-char id (3-char tag + 32) well
 * inside the bounds. Pure + I/O-free.
 */
export function focusBlockEventId(input: {
  actorUserId: string;
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  title: string;
}): string {
  const canonical = [
    input.actorUserId,
    input.windowStart.toISOString(),
    input.windowEnd.toISOString(),
    String(input.durationMinutes),
    input.title
  ].join("|");
  const digest = createHash("sha256").update(canonical).digest();
  // Map each byte's low 5 bits to a base32hex char (a-v0-9). 32 bytes → 32 chars; prefix with
  // a fixed "jfb" tag so the id is recognizably a Jarvis focus block and never starts ambiguously.
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let out = "";
  for (const byte of digest) {
    out += alphabet[byte & 0x1f];
  }
  return `jfb${out}`;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An all-day event (a reminder, a holiday, ...) comes back from Google's freeBusy API as a
 * busy interval spanning full calendar day(s): start and end both fall exactly on local
 * midnight in the account's timezone, and the duration is a whole multiple of 24h. That shape
 * is how it's told apart from a real timed conflict without a second API call — freeBusy alone
 * doesn't say whether an interval came from an all-day event.
 */
export function isAllDayInterval(interval: { start: string; end: string }, tz: string): boolean {
  const start = new Date(interval.start);
  const end = new Date(interval.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const durationMs = end.getTime() - start.getTime();
  if (durationMs <= 0 || durationMs % DAY_MS !== 0) return false;
  return isLocalMidnight(start, tz) && isLocalMidnight(end, tz);
}

function isLocalMidnight(at: Date, tz: string): boolean {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return get("hour") % 24 === 0 && get("minute") === 0 && get("second") === 0;
}

export function chooseSlot(
  window: ResolvedWindow,
  busy: ReadonlyArray<{ start: string; end: string }>,
  durationMinutes: number,
  options: { stepMinutes?: number } = {}
): SlotChoice {
  const step = (options.stepMinutes ?? 15) * 60_000;
  const durMs = durationMinutes * 60_000;
  const winStart = window.start.getTime();
  const winEnd = window.end.getTime();

  const intervals: Interval[] = busy
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => b.end > winStart && b.start < winEnd)
    .sort((a, b) => a.start - b.start);

  const overlaps = (s: number, e: number): boolean =>
    intervals.some((b) => b.start < e && b.end > s);

  for (let candidate = winStart; candidate + durMs <= winEnd; candidate += step) {
    const candEnd = candidate + durMs;
    if (!overlaps(candidate, candEnd)) {
      const shifted = candidate !== winStart;
      return {
        start: new Date(candidate),
        end: new Date(candEnd),
        shifted,
        conflict: shifted ? "shifted" : "none"
      };
    }
  }

  return {
    start: window.start,
    end: new Date(winStart + durMs),
    shifted: false,
    conflict: "no-clear-slot"
  };
}
