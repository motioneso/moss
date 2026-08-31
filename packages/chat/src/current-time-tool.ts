import { isValidTimeZone, resolveLocalDay, timeZoneOffsetMinutes } from "@moss/module-sdk/time";
import type { ToolExecute } from "@moss/module-sdk";

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

function formatLocalTime(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(instant);
}

/** #1869 slice 2: on-purpose clock check tool, sampled once per invocation, never cached. */
export function createChatGetCurrentTimeExecute(now: () => Date = () => new Date()): ToolExecute {
  return async (_scopedDb, _input, ctx) => {
    const instant = now();
    const requestedZone = ctx.localTimezone;
    const timezone = requestedZone && isValidTimeZone(requestedZone) ? requestedZone : "UTC";
    const { localDate } = resolveLocalDay(instant, timezone);
    return {
      data: {
        utcInstant: instant.toISOString(),
        timezone,
        localDate,
        localTime: formatLocalTime(instant, timezone),
        utcOffsetMinutes: timeZoneOffsetMinutes(instant, timezone)
      }
    };
  };
}

export const chatGetCurrentTimeExecute: ToolExecute = createChatGetCurrentTimeExecute();
