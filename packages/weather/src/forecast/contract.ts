import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
import {
  tryCopyVisualSnapshot,
  isValidTimeZone,
  formatInZone,
  type WeatherWindowDto
} from "@moss/shared";
import { forecastWindowSlots, HOUR_MS, validForecastQuery } from "./window.js";

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const instant = (v: unknown): v is string =>
  text(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function weatherWindowCoverage(v: WeatherWindowDto): string {
  return `${v.coverage === "complete" ? "Complete" : v.coverage === "partial" ? "Partial" : "Missing"} hourly coverage for ${v.localDate}, ${v.startHour}:00–${v.endHour}:00 (${v.timeZone}).${v.coverage !== "complete" ? " Missing intervals cannot establish the whole window." : ""}`;
}
export function readWeatherForecastSnapshot(value: unknown): WeatherWindowDto | null {
  const copied = tryCopyVisualSnapshot(value);
  if (!copied.ok) return null;
  const s = copied.snapshot;
  const v = s.fields;
  if (
    s.kind !== "weather.forecast" ||
    s.origin !== "source" ||
    s.source.id !== "open-meteo" ||
    s.source.label !== "Open-Meteo" ||
    Object.keys(v).length !== 18 ||
    !text(v.place) ||
    typeof v.approximate !== "boolean" ||
    !["stored-preference", "conversation", "timezone-fallback", "ip-geo"].includes(
      String(v.locationSource)
    ) ||
    v.approximate !== (v.locationSource === "timezone-fallback" || v.locationSource === "ip-geo") ||
    !text(v.timeZone) ||
    !isValidTimeZone(v.timeZone) ||
    !["metric", "imperial"].includes(String(v.unit)) ||
    v.windUnit !== (v.unit === "imperial" ? "mph" : "km/h") ||
    !text(v.localDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.localDate) ||
    typeof v.startHour !== "number" ||
    typeof v.endHour !== "number" ||
    !validForecastQuery({ startHour: v.startHour, endHour: v.endHour }) ||
    !instant(v.requestedStart) ||
    !instant(v.requestedEnd) ||
    !instant(v.retrievedAt) ||
    s.retrievedAt !== v.retrievedAt ||
    !(v.observedAt === null || instant(v.observedAt)) ||
    typeof v.stale !== "boolean" ||
    !Array.isArray(v.intervals) ||
    v.intervals.length === 0 ||
    v.intervals.length > 24
  )
    return null;
  const slots = forecastWindowSlots(v.localDate, v.timeZone, v.startHour, v.endHour);
  const remaining = new Set(slots);
  if (
    new Date(slots[0] ?? NaN).getTime() !== Date.parse(v.requestedStart) ||
    (slots.at(-1) ?? NaN) + HOUR_MS !== Date.parse(v.requestedEnd)
  )
    return null;
  let previous = -Infinity;
  for (const item of v.intervals) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 6 ||
      !instant(item.startsAt) ||
      !instant(item.endsAt) ||
      !finite(item.temperature, -150, 200) ||
      !text(item.condition) ||
      !(item.rainProbability === null || finite(item.rainProbability, 0, 100)) ||
      !(item.windSpeed === null || finite(item.windSpeed, 0, 500))
    )
      return null;
    const start = Date.parse(item.startsAt);
    if (
      start <= previous ||
      !remaining.delete(start) ||
      Date.parse(item.endsAt) !== start + HOUR_MS
    )
      return null;
    previous = start;
  }
  const forecast = v as unknown as WeatherWindowDto;
  if (
    v.coverage !== (remaining.size === 0 ? "complete" : "partial") ||
    v.coveredStart !== forecast.intervals[0]?.startsAt ||
    v.coveredEnd !== forecast.intervals.at(-1)?.endsAt ||
    s.coverage !== weatherWindowCoverage(forecast)
  )
    return null;
  return forecast;
}
export function formatWeatherForecastSnapshot(value: unknown): string {
  const v = readWeatherForecastSnapshot(value);
  if (!v) return "";
  const degree = v.unit === "imperial" ? "°F" : "°C";
  const rows = v.intervals.map(
    (item) =>
      `${formatInZone(item.startsAt, v.timeZone, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}: ${item.temperature}${degree}, ${item.condition}; rain ${item.rainProbability === null ? "unknown" : `${item.rainProbability}%`}; wind ${item.windSpeed === null ? "unknown" : `${item.windSpeed} ${v.windUnit}`}`
  );
  return `${v.place}${v.approximate ? " (approximate location)" : ""} · ${v.localDate}, ${v.startHour}:00–${v.endHour}:00 · ${v.timeZone}. ${rows.join(". ")}. Open-Meteo; retrieved ${v.retrievedAt}; observation ${v.observedAt ?? "unavailable"}.${v.stale ? " Stale snapshot." : ""} ${weatherWindowCoverage(v)}`;
}
export const weatherForecastTemplate: ModuleVisualTemplate = Object.freeze({
  kind: "weather.forecast",
  snapshotKind: "weather.forecast",
  validate: (value: unknown) => readWeatherForecastSnapshot(value) !== null,
  format: formatWeatherForecastSnapshot
});
export default [weatherForecastTemplate];
