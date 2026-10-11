import { DEFAULT_LOCALE_SETTINGS, type LocaleDateFormat, isValidTimeZone } from "@moss/shared";

/** Extract an IANA timezone string from a raw locale preference blob. Returns null on any invalid input. */
export function extractTimezone(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const tz = (raw as Record<string, unknown>).timezone;
  if (typeof tz !== "string" || tz.length > 100 || !isValidTimeZone(tz)) return null;
  return tz.trim();
}

/**
 * The timezone the actor effectively lives in: the stored one when present and valid, otherwise
 * the same default `GET /api/me/locale` shows them (#2157). Use this wherever the assistant tells
 * the user what time it is; use `extractTimezone` only when "nothing stored" must stay observable.
 */
export function resolveEffectiveTimezone(raw: unknown): string {
  return extractTimezone(raw) ?? DEFAULT_LOCALE_SETTINGS.timezone;
}

/** The actor's 12- or 24-hour clock, falling back to the same default `GET /api/me/locale` shows. */
export function resolveClockFormat(raw: unknown): LocaleDateFormat {
  const format =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).dateFormat : null;
  return format === "12" || format === "24" ? format : DEFAULT_LOCALE_SETTINGS.dateFormat;
}
