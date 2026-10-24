import type { WeatherWindowDto } from "@moss/shared";

/** Bounded prose checks complement exact card assertions and review of every recorded answer. */
export function hasUsefulWeatherAnswer(reply: unknown, forecast: WeatherWindowDto): boolean {
  if (typeof reply !== "string" || reply.trim().length < 30) return false;
  if (
    /root\s*=|(?:don[’']t|do not|can[’']t|cannot)\s+(?:know|tell|access|fetch|retrieve)|unable to|couldn[’']t\s+(?:find|get|fetch|retrieve)|check another forecast|no (?:weather|forecast) data/i.test(
      reply
    )
  )
    return false;
  if (
    !/jacket|layer|umbrella|wear|pack|bring|comfortable|cool|warm|rain|wind|temperature/i.test(
      reply
    )
  )
    return false;
  const temperatures = forecast.intervals.map((item) => item.temperature);
  const degree = forecast.unit === "imperial" ? "F" : "C";
  const measurements = [
    ...reply.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:[–—−-]\s*(-?\d+(?:\.\d+)?))?\s*°\s*([FC])?/gi)
  ];
  // A sourced temperature makes the short interpretation useful without relying on the card.
  if (!measurements.length) return false;
  return measurements.every(
    (match) =>
      (!match[3] || match[3].toUpperCase() === degree) &&
      [match[1], match[2]]
        .filter((value) => value !== undefined)
        .every(
          (value) =>
            Number(value) >= Math.min(...temperatures) - 0.6 &&
            Number(value) <= Math.max(...temperatures) + 0.6
        )
  );
}
