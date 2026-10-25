import { formatInZone, localDay, type WeatherWindowDto } from "@moss/shared";
import { forecastWindowSlots, HOUR_MS } from "./window.js";

const clock = (at: string | number, zone: string) =>
  formatInZone(at, zone, { hour: "numeric", hour12: true }, "en-US");

export function intervalLabel(start: number, end: number, zone: string): string {
  const from = clock(start, zone);
  const to = clock(end, zone);
  const samePeriod = from.slice(-2) === to.slice(-2);
  return `${samePeriod ? from.slice(0, -3) : from}–${to}`;
}

export function forecastPresentation(v: WeatherWindowDto) {
  const byStart = new Map(v.intervals.map((item) => [Date.parse(item.startsAt), item]));
  const slots = forecastWindowSlots(v.localDate, v.timeZone, v.startHour, v.endHour);
  const labels = slots.map((at) => clock(at, v.timeZone));
  const hours = slots.map((at, index) => {
    const item = byStart.get(at);
    // Distinguish both occurrences in a DST fold; never collapse actual hourly buckets.
    const repeated = labels.indexOf(labels[index]!) !== labels.lastIndexOf(labels[index]!);
    const zone = repeated
      ? ` ${formatInZone(at, v.timeZone, { timeZoneName: "short" }, "en-US").split(", ").at(-1)}`
      : "";
    return {
      at,
      item,
      label: intervalLabel(at, at + HOUR_MS, v.timeZone) + zone,
      temperature: item ? Math.round(item.temperature) : null
    };
  });
  const temperatures = v.intervals.map((item) => Math.round(item.temperature));
  const min = Math.min(...temperatures);
  const max = Math.max(...temperatures);
  const counts = new Map<string, number>();
  for (const item of v.intervals) counts.set(item.condition, (counts.get(item.condition) ?? 0) + 1);
  const condition = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const sameDay = localDay(v.retrievedAt, v.timeZone) === v.localDate;
  const evening = v.startHour >= 17 && v.endHour <= 24;
  const day = sameDay
    ? evening
      ? "This evening"
      : "Today"
    : formatInZone(
        v.requestedStart,
        v.timeZone,
        { weekday: "short", month: "short", day: "numeric" },
        "en-US"
      );
  const date = formatInZone(
    v.requestedStart,
    v.timeZone,
    { weekday: "short", month: "short", day: "numeric" },
    "en-US"
  );
  const zone = formatInZone(v.requestedStart, v.timeZone, { timeZoneName: "short" }, "en-US")
    .split(", ")
    .at(-1);
  return {
    hours,
    min,
    max,
    condition,
    day,
    window: `${date} · ${intervalLabel(Date.parse(v.requestedStart), Date.parse(v.requestedEnd), v.timeZone)} ${zone}`,
    peak(values: readonly (number | null)[], unit: string) {
      return values.every((n): n is number => n !== null)
        ? `${Math.round(Math.max(...values))}${unit}`
        : "Unknown";
    }
  };
}
