import { addLocalDays, localDayRange } from "@moss/module-sdk/time";
import {
  formatInZone,
  isValidTimeZone,
  localDay,
  type WeatherForecastQuery,
  type WeatherIntervalDto,
  type WeatherUnit,
  type WeatherWindowDto
} from "@moss/shared";
import type { ResolvedWeatherLocation } from "../preferences.js";

export const HOUR_MS = 60 * 60 * 1000;
export interface IntervalForecast {
  readonly timeZone: string;
  readonly unit: WeatherUnit;
  readonly windUnit: "mph" | "km/h";
  readonly retrievedAt: string;
  readonly observedAt: string | null;
  readonly intervals: readonly WeatherIntervalDto[];
}
export function validForecastQuery(query: WeatherForecastQuery): boolean {
  const start = query.startHour ?? 18;
  const end = query.endHour ?? 22;
  const day = query.dayOffset ?? 0;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= 24 &&
    end > start &&
    end - start <= 12 &&
    Number.isInteger(day) &&
    day >= 0 &&
    day <= 4
  );
}
/** Enumerate actual instants, retaining both occurrences in a fold and omitting DST gaps. */
export function forecastWindowSlots(
  localDate: string,
  timeZone: string,
  startHour: number,
  endHour: number
): number[] {
  const range = localDayRange(localDate, timeZone);
  const slots: number[] = [];
  for (let at = range.start.getTime(); at < range.end.getTime(); at += HOUR_MS) {
    const hour = Number(formatInZone(at, timeZone, { hour: "2-digit", hourCycle: "h23" }, "en-US"));
    if (hour >= startHour && hour < endHour) slots.push(at);
  }
  return slots;
}
export function selectForecastWindow(
  source: IntervalForecast,
  location: ResolvedWeatherLocation,
  query: WeatherForecastQuery,
  now: Date
): WeatherWindowDto | null {
  if (!validForecastQuery(query) || !isValidTimeZone(source.timeZone)) return null;
  const localDate = addLocalDays(localDay(now, source.timeZone), query.dayOffset ?? 0);
  const startHour = query.startHour ?? 18;
  const endHour = query.endHour ?? 22;
  const slots = forecastWindowSlots(localDate, source.timeZone, startHour, endHour);
  if (slots.length === 0) return null;
  const wanted = new Set(slots);
  const seen = new Set<number>();
  const intervals = source.intervals
    .filter((item) => {
      const at = Date.parse(item.startsAt);
      if (!wanted.has(at) || seen.has(at) || Date.parse(item.endsAt) !== at + HOUR_MS) return false;
      seen.add(at);
      return true;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return {
    place: location.location.label,
    approximate: location.source === "timezone-fallback" || location.source === "ip-geo",
    locationSource: location.source,
    timeZone: source.timeZone,
    unit: source.unit,
    windUnit: source.windUnit,
    localDate,
    startHour,
    endHour,
    requestedStart: new Date(slots[0]!).toISOString(),
    requestedEnd: new Date(slots.at(-1)! + HOUR_MS).toISOString(),
    coveredStart: intervals[0]?.startsAt ?? null,
    coveredEnd: intervals.at(-1)?.endsAt ?? null,
    coverage:
      intervals.length === slots.length ? "complete" : intervals.length ? "partial" : "missing",
    observedAt: source.observedAt,
    retrievedAt: source.retrievedAt,
    stale:
      now.getTime() - Date.parse(source.retrievedAt) > 30 * 60_000 ||
      (source.observedAt !== null && now.getTime() - Date.parse(source.observedAt) > 2 * HOUR_MS),
    intervals
  };
}
