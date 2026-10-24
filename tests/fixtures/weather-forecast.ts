import type { WeatherIntervalDto } from "@moss/shared";
import {
  forecastWindowSlots,
  HOUR_MS,
  selectForecastWindow,
  type IntervalForecast
} from "../../packages/weather/src/forecast/window.js";
import { weatherForecastSnapshot } from "../../packages/weather/src/forecast/tool.js";

export const weatherNow = new Date("2026-10-24T10:00:00.000Z");
export const weatherPlace = {
  location: { lat: 34.05, lon: -118.24, label: "Los Angeles, California, United States" },
  source: "stored-preference" as const
};
export function weatherIntervals(
  date = "2026-10-24",
  zone = "America/Los_Angeles",
  start = 18,
  end = 22
): WeatherIntervalDto[] {
  return forecastWindowSlots(date, zone, start, end).map((at, index) => ({
    startsAt: new Date(at).toISOString(),
    endsAt: new Date(at + HOUR_MS).toISOString(),
    temperature: 60 - index,
    condition: "Partly cloudy",
    rainProbability: 10 + index,
    windSpeed: 8
  }));
}
export function intervalSource(overrides: Partial<IntervalForecast> = {}): IntervalForecast {
  return {
    timeZone: "America/Los_Angeles",
    unit: "imperial",
    windUnit: "mph",
    retrievedAt: weatherNow.toISOString(),
    observedAt: weatherNow.toISOString(),
    intervals: weatherIntervals(),
    ...overrides
  };
}
export function forecastSnapshot() {
  return {
    ...weatherForecastSnapshot(
      selectForecastWindow(intervalSource(), weatherPlace, {}, weatherNow)!
    ),
    ref: "weather-ref"
  };
}
export function hourlyPayload() {
  const intervals = weatherIntervals();
  return {
    timezone: "America/Los_Angeles",
    current: { time: weatherNow.getTime() / 1000 },
    hourly_units: {
      time: "unixtime",
      temperature_2m: "°F",
      precipitation_probability: "%",
      wind_speed_10m: "mph"
    },
    hourly: {
      time: intervals.map((v) => Date.parse(v.startsAt) / 1000),
      temperature_2m: intervals.map((v) => v.temperature),
      weather_code: [2, 2, 3, 61],
      precipitation_probability: [10, 20, 30, 40],
      wind_speed_10m: [8, 7, 6, 5]
    }
  };
}
