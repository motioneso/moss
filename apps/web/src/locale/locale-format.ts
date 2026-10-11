import { useQuery } from "@tanstack/react-query";

import {
  formatLocaleDate,
  formatLocaleDateTime,
  formatLocaleTime,
  isValidTimeZone,
  type LocaleSettingsDto
} from "@moss/shared";

import { getLocaleSettings } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";

/**
 * Shared user-local date/time formatting (#579).
 *
 * Every user-facing date/time renders in the user's persisted locale — IANA
 * timezone + 12/24-hour preference + BCP-47 region — sourced from the owner-scoped
 * `/api/me/locale` store (the single source of truth; see
 * packages/settings/src/locale-routes.ts). Bare `Date#toLocale*` / `Intl.DateTimeFormat`
 * resolve to the *ambient* runtime zone (the browser's, or the headless server's) and
 * are therefore wrong for the user. Route every display site through this module; the
 * `check:no-ambient-dates` gate enforces it.
 *
 * Timestamps stay UTC at rest — only their *presentation* is zoned here. The
 * formatters are `@moss/shared`'s `formatLocale*` (the one person-time formatter shared
 * with the server, #3390); day-bucketing call sites use shared `localDay` directly.
 */

/**
 * Locale used until the persisted preference loads. Mirrors the server's
 * `DEFAULT_LOCALE_SETTINGS` (packages/settings/src/locale-routes.ts) so first paint
 * matches the eventual value in the common case and never flashes an ambient-zone date.
 */
export const DEFAULT_LOCALE: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};

type DateInput = string | number | Date;

function toDate(input: DateInput): Date | null {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format an instant as a date in the user's locale (default: medium date). */
export const formatDate = formatLocaleDate;

/** Format an instant as date + time in the user's locale. */
export const formatDateTime = formatLocaleDateTime;

/** Format an instant as a time-of-day in the user's locale (honours 12/24-hour preference). */
export const formatTime = formatLocaleTime;

/**
 * Format a zone-less wall-clock "HH:MM" (e.g. a dose time already expressed in its own zone)
 * per the user's 12/24-hour preference. No zone conversion happens. Input that is not an
 * "HH:MM" clock, or that the formatter cannot render, is returned unchanged.
 */
export function formatClockTime(clock: string, locale: LocaleSettingsDto): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(clock);
  if (!match) return clock;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return clock;
  return formatTime(Date.UTC(2000, 0, 1, hour, minute), { ...locale, timezone: "UTC" }) || clock;
}

export { isValidTimeZone };

export function zonedClockParts(
  input: DateInput,
  timeZone?: string
): { readonly hour: number; readonly minute: number; readonly second: number } | null {
  const date = toDate(input);
  if (!date) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    return {
      hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24,
      minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0"),
      second: Number(parts.find((part) => part.type === "second")?.value ?? "0")
    };
  } catch {
    return {
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds()
    };
  }
}

export function zonedClockMinutes(input: DateInput, timeZone?: string): number | null {
  const parts = zonedClockParts(input, timeZone);
  return parts ? parts.hour * 60 + parts.minute : null;
}

/**
 * React hook returning the user's persisted locale, falling back to {@link DEFAULT_LOCALE}
 * until `/api/me/locale` resolves. Single React-Query entry (`queryKeys.settings.locale`),
 * so the fetch is shared/deduplicated across every surface that formats dates.
 */
export function useUserLocale(): LocaleSettingsDto {
  const query = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: () => getLocaleSettings()
  });
  return query.data?.locale ?? DEFAULT_LOCALE;
}
