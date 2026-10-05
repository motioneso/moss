import { useQuery } from "@tanstack/react-query";
import { requestJson } from "@moss/module-web-sdk";
import { formatInZone, type GetLocaleSettingsResponse } from "@moss/shared";

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
