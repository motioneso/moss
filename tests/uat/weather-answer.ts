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
    ...reply.matchAll(
      /(?<![\d:])(-?\d+(?:\.\d+)?)\s*(?:(?:[–—−-]|to|and)\s*(-?\d+(?:\.\d+)?))?\s*(?:°\s*(F(?:ahrenheit)?|C(?:elsius)?)?|degrees?(?:\s*(F(?:ahrenheit)?|C(?:elsius)?))?|\b(Fahrenheit|Celsius|[FC])\b)/gi
    )
  ];
  const rain = [...reply.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  const rainProbabilities = forecast.intervals.flatMap((item) =>
    item.rainProbability === null ? [] : [item.rainProbability]
  );
  // Source-grounded rain advice can be useful without repeating temperatures from the card.
  if (!measurements.length && (!rain.length || !/rain|umbrella/i.test(reply))) return false;
  return (
    rain.every(
      (match) =>
        rainProbabilities.length > 0 &&
        Number(match[1]) >= Math.min(...rainProbabilities) - 0.6 &&
        Number(match[1]) <= Math.max(...rainProbabilities) + 0.6
    ) &&
    measurements.every((match) => {
      const prefix = reply.slice(Math.max(0, match.index! - 50), match.index).replace(/[*_]/g, "");
      const difference = prefix.match(
        /\b(drop|decrease|rise|increase)\s+of\s+(?:(?:about|around|roughly|approximately)\s+)?$/i
      );
      const change = difference
        ? /drop|decrease/i.test(difference[1]!)
          ? temperatures[0]! - temperatures.at(-1)!
          : temperatures.at(-1)! - temperatures[0]!
        : null;
      return (
        (!(match[3] || match[4] || match[5]) ||
          (match[3] || match[4] || match[5])!.charAt(0).toUpperCase() === degree) &&
        [match[1], match[2]]
          .filter((value) => value !== undefined)
          .every((value) =>
            change === null
              ? Number(value) >= Math.min(...temperatures) - 0.6 &&
                Number(value) <= Math.max(...temperatures) + 0.6
              : change >= 0 && Math.abs(Number(value) - change) <= 0.6 + 1e-9
          )
      );
    })
  );
}
