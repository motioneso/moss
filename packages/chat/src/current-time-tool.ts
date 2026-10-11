import { isValidTimeZone, resolveLocalDay, timeZoneOffsetMinutes } from "@moss/module-sdk/time";
import type { ToolExecute } from "@moss/module-sdk";
import { DEFAULT_LOCALE_SETTINGS, formatLocaleTime } from "@moss/shared";

export const chatGetCurrentTimeOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["utcInstant", "timezone", "localDate", "localTime", "utcOffsetMinutes"],
  properties: {
    utcInstant: { type: "string" },
    timezone: { type: "string" },
    localDate: { type: "string" },
    localTime: { type: "string" },
    utcOffsetMinutes: { type: "integer" }
  }
} as const;

/**
 * #1869 slice 2: on-purpose clock check tool, sampled once per invocation, never cached. The
 * local time uses the person's region and 12/24-hour choice; without a resolved locale it falls
 * back to the same default Settings shows, never UTC.
 */
export function createChatGetCurrentTimeExecute(now: () => Date = () => new Date()): ToolExecute {
  return async (_scopedDb, _input, ctx) => {
    const instant = now();
    const locale = ctx.locale ?? DEFAULT_LOCALE_SETTINGS;
    const requestedZone = ctx.localTimezone ?? locale.timezone;
    const timezone = isValidTimeZone(requestedZone)
      ? requestedZone
      : DEFAULT_LOCALE_SETTINGS.timezone;
    const { localDate } = resolveLocalDay(instant, timezone);
    return {
      data: {
        utcInstant: instant.toISOString(),
        timezone,
        localDate,
        localTime: formatLocaleTime(
          instant,
          { ...locale, timezone },
          { hour: "numeric", minute: "2-digit", second: "2-digit" }
        ),
        utcOffsetMinutes: timeZoneOffsetMinutes(instant, timezone)
      }
    };
  };
}

export const chatGetCurrentTimeExecute: ToolExecute = createChatGetCurrentTimeExecute();
