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
    .filter((item) => withinLocalDay(item["startsAt"], now, timeZone))
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

function degrees(value: number, unit: "metric" | "imperial"): string {
  return `${value}°${unit === "metric" ? "C" : "F"}`;
}

/**
 * Today's forecast as one line, read through the weather module's public service. A missing
 * port or an unresolved location leaves the section empty; a failed read also records a gap.
 */
export async function gatherWeatherSection(
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps,
  timeZone: string,
  gaps: BriefingGap[]
): Promise<Section> {
  const empty = emptySection(WEATHER_SECTION_KEY, WEATHER_SECTION_LABEL);
  if (!deps.weatherToday) return empty;
  let weather;
  try {
    weather = await deps.weatherToday(ctxFor(definition, input), timeZone);
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
