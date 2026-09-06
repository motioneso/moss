import { useQuery } from "@tanstack/react-query";

import { formatInZone, type GetLocaleSettingsResponse, type LocaleSettingsDto } from "@moss/shared";
import { requestJson } from "@moss/module-web-sdk";

/**
 * Self-contained subset of `apps/web/src/locale/locale-format.ts` for the workshop module's web
 * contribution.
 *
 * Packages cannot import `apps/web/src/*` internals (module isolation — see CLAUDE.md "Module
 * isolation" / docs/superpowers/specs/2026-07-04-module-web-registry.md), so this duplicates only
 * what workshop needs, delegating the actual timezone math to `@moss/shared`'s
 * `formatInZone` (the single source of truth both copies share). The query key
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

/** Format an instant as a date in the user's locale (default: medium date). */
export function formatDate(
  input: DateInput,
  locale: LocaleSettingsDto,
  options?: Intl.DateTimeFormatOptions
): string {
  return format(input, locale, options ?? DATE_OPTS);
}

export function useUserLocale(): LocaleSettingsDto {
  const query = useQuery({
    queryKey: LOCALE_QUERY_KEY,
    queryFn: () => requestJson<GetLocaleSettingsResponse>("/api/me/locale")
  });
  return query.data?.locale ?? DEFAULT_LOCALE;
}
