/**
 * The person's saved locale for settings panes (#3396). Module settings cannot import the app's
 * own hook (module isolation), so this reads the same `/api/me/locale` record under the same
 * query key as `apps/web`'s `useUserLocale`, sharing its cache entry.
 */

import { useQuery } from "@tanstack/react-query";

import {
  DEFAULT_LOCALE_SETTINGS,
  type GetLocaleSettingsResponse,
  type LocaleSettingsDto
} from "@moss/shared";

const LOCALE_QUERY_KEY = ["settings", "locale"] as const;

async function getLocaleSettings(): Promise<GetLocaleSettingsResponse> {
  const response = await fetch("/api/me/locale", {
    credentials: "include",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error("Failed to load locale settings");
  return (await response.json()) as GetLocaleSettingsResponse;
}

/**
 * The person's locale and whether it has loaded. Until it loads `locale` is the shared default,
 * and `failed` reports a load that gave up; `retry` asks again.
 */
export function useUserLocaleStatus(): {
  locale: LocaleSettingsDto;
  ready: boolean;
  failed: boolean;
  retry: () => void;
} {
  const query = useQuery({ queryKey: LOCALE_QUERY_KEY, queryFn: getLocaleSettings });
  return {
    locale: query.data?.locale ?? DEFAULT_LOCALE_SETTINGS,
    ready: query.data !== undefined,
    failed: query.data === undefined && query.isError,
    retry: () => void query.refetch()
  };
}

/** The person's locale; the shared default until it loads. */
export function useUserLocale(): LocaleSettingsDto {
  return useUserLocaleStatus().locale;
}
