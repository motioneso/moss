import type { BriefingDefinition } from "@moss/db";

import {
  capLines,
  ctxFor,
  emptySection,
  withinLocalDay,
  type BriefingGap,
  type ComposeDeps,
  type ComposeRunInput,
  type Section
} from "./compose-shared.js";
import { sanitizeExternal } from "./trust-boundary.js";

export const CALENDAR_TODAY_SECTION_KEY = "calendar_today";
export const CALENDAR_TODAY_SECTION_LABEL = "TODAY'S EVENTS";
export const WEATHER_SECTION_KEY = "weather";
export const WEATHER_SECTION_LABEL = "WEATHER";

function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

function eventLine(item: Record<string, unknown>, timeZone: string): string {
  const startsAt = item["startsAt"] as string;
  const endsAt = typeof item["endsAt"] === "string" ? item["endsAt"] : null;
  const endValid = endsAt !== null && !Number.isNaN(new Date(endsAt).getTime());
  const when =
    item["allDay"] === true
      ? "All day"
      : endValid
        ? `${localTime(startsAt, timeZone)}-${localTime(endsAt, timeZone)}`
        : localTime(startsAt, timeZone);
  const title = sanitizeExternal(item["title"]) || "Untitled event";
  const place = sanitizeExternal(item["location"]);
  return [when, title, place ? `at ${place}` : ""].filter(Boolean).join(" · ");
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

// All-day events are stored as UTC midnights with an exclusive end date, so they compare as
// calendar dates. Converting them to local time would move them to the previous day west of UTC.
function coversToday(item: Record<string, unknown>, now: Date, timeZone: string): boolean {
  if (item["allDay"] !== true) return withinLocalDay(item["startsAt"], now, timeZone);
  const start = typeof item["startsAt"] === "string" ? item["startsAt"].slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const end = typeof item["endsAt"] === "string" ? item["endsAt"].slice(0, 10) : "";
  const today = localDate(now, timeZone);
  return /^\d{4}-\d{2}-\d{2}$/.test(end) && end > start
    ? start <= today && today < end
    : start === today;
}

/**
 * The day's real events in time order, one line each (time, title, place). The calendar
 * section carries only derived warnings, so without this a normal day gives the writer nothing.
 */
export function calendarTodaySection(
  rawItems: readonly Record<string, unknown>[] | undefined,
  now: Date,
  timeZone: string
): Section {
  const events = (rawItems ?? [])
    .filter((item) => coversToday(item, now, timeZone))
    .sort(
      (a, b) =>
        new Date(a["startsAt"] as string).getTime() - new Date(b["startsAt"] as string).getTime()
    );
  if (events.length === 0) {
    return emptySection(CALENDAR_TODAY_SECTION_KEY, CALENDAR_TODAY_SECTION_LABEL);
  }
  const lines = events.map((item) => eventLine(item, timeZone));
  const capped = capLines(lines);
  return {
    key: CALENDAR_TODAY_SECTION_KEY,
    label: CALENDAR_TODAY_SECTION_LABEL,
    lines: capped.lines,
    count: events.length
  };
}

export const WEATHER_READ_TIMEOUT_MS = 10_000;

function degrees(value: number, unit: "metric" | "imperial"): string {
  return `${value}°${unit === "metric" ? "C" : "F"}`;
}

/**
 * Today's forecast as one line, read through the weather module's public service. A missing
 * port or an unresolved location leaves the section empty; a failed or slow read also records
 * a gap.
 */
export async function gatherWeatherSection(
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps,
  timeZone: string,
  gaps: BriefingGap[],
  timeoutMs: number = WEATHER_READ_TIMEOUT_MS
): Promise<Section> {
  const empty = emptySection(WEATHER_SECTION_KEY, WEATHER_SECTION_LABEL);
  if (!deps.weatherToday) return empty;
  let weather;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A stalled forecast must not hold up the briefing, so a slow read counts as a failed one.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("weather read timed out");
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
    });
    weather = await Promise.race([deps.weatherToday(ctxFor(definition, input), timeZone), timeout]);
  } catch (error) {
    deps.logger?.error(
      {
        event: "briefing_tool_failed",
        tool: WEATHER_SECTION_KEY,
        error: error instanceof Error ? error.name : "UnknownError"
      },
      "briefing weather read failed"
    );
    gaps.push({ source: WEATHER_SECTION_KEY, reason: "tool_failed" });
    return empty;
  } finally {
    clearTimeout(timer);
  }
  if (!weather) return empty;
  const place = sanitizeExternal(weather.location);
  const now = `${sanitizeExternal(weather.condition)} now, ${degrees(weather.temp, weather.unit)} (feels like ${degrees(weather.feelsLike, weather.unit)})`;
  const outlook = weather.today
    ? `today ${sanitizeExternal(weather.today.condition)}, high ${degrees(weather.today.high, weather.unit)}, low ${degrees(weather.today.low, weather.unit)}`
    : "";
  const line = [place ? `${place}:` : "", now, outlook ? `; ${outlook}` : ""]
    .filter(Boolean)
    .join(" ")
    .replace(" ;", ";");
  return {
    key: WEATHER_SECTION_KEY,
    label: WEATHER_SECTION_LABEL,
    lines: [line],
    count: 1
  };
}
