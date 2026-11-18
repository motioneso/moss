/** Date and time formatting in the viewer's own zone and region (read from the browser). */

export function userLocale() {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  return { timezone: resolved.timeZone || "UTC", region: resolved.locale || "en-US" };
}

function format(input, locale, options) {
  const date = input instanceof Date ? input : new Date(input);
  try {
    return new Intl.DateTimeFormat(locale.region, { timeZone: locale.timezone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}

export function formatDate(input, locale, options) {
  return format(input, locale, options ?? { year: "numeric", month: "short", day: "numeric" });
}

export function formatTime(input, locale, options) {
  return format(input, locale, options ?? { hour: "numeric", minute: "2-digit" });
}

/** Short zone name such as "PDT"; empty when unknown. */
export function formatTimeZoneShort(input, locale) {
  try {
    const date = input instanceof Date ? input : new Date(input);
    const part = new Intl.DateTimeFormat(locale.region, { timeZone: locale.timezone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName");
    return part ? part.value : "";
  } catch {
    return "";
  }
}

/** Calendar day (YYYY-MM-DD) of an instant in the viewer's zone. */
export function localDay(input, locale) {
  const date = input instanceof Date ? input : new Date(input);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: locale.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
