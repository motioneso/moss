import { useQuery } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import { formatInZone, localDay, type GetLocaleSettingsResponse } from "@moss/shared";

/** Shares the host locale cache; modules cannot import the host's private formatting hook. */
export function useMeetingDate(
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" }
) {
  const locale = useQuery({
    queryKey: ["settings", "locale"],
    queryFn: () => requestJson<GetLocaleSettingsResponse>("/api/me/locale")
  });
  return (date: string) => {
    if (!locale.data) return "Date unavailable until locale loads";
    const { timezone, region, dateFormat } = locale.data.locale;
    return formatInZone(date, timezone, { hour12: dateFormat === "12", ...options }, region);
  };
}

/** Group by calendar weeks in the owner's timezone, including near-midnight/DST boundaries. */
export function meetingWeekStart(iso: string, timezone: string): string {
  const date = new Date(`${localDay(iso, timezone)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString();
}
export function useMeetingWeek() {
  const locale = useQuery({
    queryKey: ["settings", "locale"],
    queryFn: () => requestJson<GetLocaleSettingsResponse>("/api/me/locale")
  });
  return (iso: string) => {
    if (!locale.data) return { key: "loading", label: "Meetings" };
    const key = meetingWeekStart(iso, locale.data.locale.timezone);
    return {
      key,
      label: `Week of ${formatInZone(key, "UTC", { year: "numeric", month: "short", day: "numeric" }, locale.data.locale.region)}`
    };
  };
}
