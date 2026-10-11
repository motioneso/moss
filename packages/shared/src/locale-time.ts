/**
 * The person's own time: one formatter for every instant shown to a person, on the
 * server and in the browser (#3390). It applies the person's saved timezone, their
 * 12/24-hour choice and their region; the stored instant stays UTC.
 *
 * Server code reads the raw `locale` preference and passes it through
 * `resolveEffectiveLocale`, so a person with nothing saved gets the same default
 * `GET /api/me/locale` reports instead of UTC.
 */

import { DEFAULT_LOCALE_SETTINGS, type LocaleSettingsDto } from "./platform-api.js";
import { formatInZone, isValidTimeZone } from "./time.js";

type DateInput = string | number | Date;

/** Preference key the person's locale is stored under. */
export const LOCALE_PREFERENCE_KEY = "locale";

/** The person's effective locale from a raw stored preference; invalid parts take the default. */
export function resolveEffectiveLocale(raw: unknown): LocaleSettingsDto {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_LOCALE_SETTINGS;
  const record = raw as Record<string, unknown>;
  const timezone =
    typeof record.timezone === "string" &&
    record.timezone.length <= 100 &&
    isValidTimeZone(record.timezone)
      ? record.timezone.trim()
      : DEFAULT_LOCALE_SETTINGS.timezone;
  const region =
    typeof record.region === "string" && record.region.length <= 35 && record.region.trim()
      ? record.region.trim()
      : DEFAULT_LOCALE_SETTINGS.region;
  const dateFormat =
    record.dateFormat === "12" || record.dateFormat === "24"
      ? record.dateFormat
      : DEFAULT_LOCALE_SETTINGS.dateFormat;
  return { timezone, region, dateFormat };
}

function localeTag(region: string): string | undefined {
  const tag = region.trim();
  return tag.length > 0 ? tag : undefined;
}

function formatForPerson(
  input: DateInput,
  locale: LocaleSettingsDto,
  options: Intl.DateTimeFormatOptions
): string {
  return formatInZone(
    input,
    locale.timezone,
    { hour12: locale.dateFormat === "12", ...options },
    localeTag(locale.region)
  );
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
};
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** An instant as a date in the person's locale (default: medium date). */
export function formatLocaleDate(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return formatForPerson(input, locale, options ?? DATE_OPTS);
}

/** An instant as date and time in the person's locale. */
export function formatLocaleDateTime(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return formatForPerson(input, locale, options ?? DATETIME_OPTS);
}

/** An instant as a time of day in the person's locale and 12/24-hour choice. */
export function formatLocaleTime(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return formatForPerson(input, locale, options ?? TIME_OPTS);
}
