import { useQuery } from "@tanstack/react-query";

import { formatInZone, isValidTimeZone, type LocaleSettingsDto } from "@moss/shared";
import { requestJson } from "@moss/module-web-sdk";

/**
 * Self-contained subset of `apps/web/src/locale/locale-format.ts` for the sports module's web
 * contribution.
 *
 * Packages cannot import `apps/web/src/*` internals (module isolation — see CLAUDE.md "Module
 * isolation" / docs/superpowers/specs/2026-07-04-module-web-registry.md), so this duplicates only
 * what sports needs, delegating the actual timezone math to `@moss/shared`'s
 * `formatInZone`/`isValidTimeZone` (the single source of truth both copies share). The query key
 * below is a value-identical literal to apps/web's `queryKeys.settings.locale` (not imported) so
 * this hook's fetch shares its React-Query cache entry with the rest of the app.
 */
const LOCALE_QUERY_KEY = ["settings", "locale"] as const;

type DateInput = string | number | Date;

export const DEFAULT_LOCALE: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};

interface GetLocaleSettingsResponse {
  readonly locale: LocaleSettingsDto;
}

function localeTag(region: string): string | undefined {
  const tag = region.trim();
  return tag.length > 0 ? tag : undefined;
}

function format(
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
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

export function formatDate(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return format(input, locale, options ?? DATE_OPTS);
}

/** Short zone name ("PDT") for labels; empty when the zone is unknown. */
export function formatTimeZoneShort(input: DateInput, locale: LocaleSettingsDto): string {
  try {
    const part = new Intl.DateTimeFormat(localeTag(locale.region) ?? "en-US", {
      timeZone: locale.timezone,
      timeZoneName: "short"
    })
      .formatToParts(typeof input === "string" ? new Date(input) : input)
      .find((candidate) => candidate.type === "timeZoneName");
    if (part) return part.value;
  } catch {
    // Below: empty string.
  }
  return "";
}

export function formatTime(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return format(input, locale, options ?? TIME_OPTS);
}

export { isValidTimeZone };

export function useUserLocale(): LocaleSettingsDto {
  const query = useQuery({
    queryKey: LOCALE_QUERY_KEY,
    queryFn: () => requestJson<GetLocaleSettingsResponse>("/api/me/locale")
  });
  return query.data?.locale ?? DEFAULT_LOCALE;
}
