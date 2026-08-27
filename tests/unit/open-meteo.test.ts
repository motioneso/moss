import { describe, expect, it, vi } from "vitest";

import {
  fetchOpenMeteoForecast,
  WeatherUnavailableError
} from "../../packages/weather/src/open-meteo.js";

describe("fetchOpenMeteoForecast", () => {
  it("throws WeatherUnavailableError when the response body is not valid JSON", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("bad json"))
    })) as unknown as typeof fetch;

    await expect(
      fetchOpenMeteoForecast(1, 2, "metric", "Testville", fetchFn)
    ).rejects.toBeInstanceOf(WeatherUnavailableError);
  });

  it("throws a plain Error (not WeatherUnavailableError) on a non-ok HTTP status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    const promise = fetchOpenMeteoForecast(1, 2, "metric", "Testville", fetchFn);
    await expect(promise).rejects.not.toBeInstanceOf(WeatherUnavailableError);
    await expect(promise).rejects.toThrow("Open-Meteo returned 503");
  });

  it("parses a valid response into a WeatherTodayDto", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 21.4,
          apparent_temperature: 20.1,
          weather_code: 0,
          relative_humidity_2m: 55.4,
          dew_point_2m: 12.6,
          wind_speed_10m: 9.2
        },
        daily: {
          time: ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
          weather_code: [0, 2, 61, 3, 71],
          temperature_2m_max: [24.1, 22.8, 19.4, 20.9, 15.2],
          temperature_2m_min: [14.2, 13.1, 11.6, 10.8, 8.4]
        }
      })
    })) as unknown as typeof fetch;

    await expect(fetchOpenMeteoForecast(1, 2, "metric", "Testville", fetchFn)).resolves.toEqual({
      temp: 21,
      feelsLike: 20,
      condition: "Clear sky",
      icon: "sun",
      location: "Testville",
      unit: "metric",
      humidity: 55,
      dewPoint: 13,
      windSpeed: 9,
      lat: 1,
      lon: 2,
      forecast: [
        { date: "2026-08-25", icon: "cloud-sun", high: 23, low: 13 },
        { date: "2026-08-26", icon: "cloud-rain", high: 19, low: 12 },
        { date: "2026-08-27", icon: "cloud", high: 21, low: 11 },
        { date: "2026-08-28", icon: "cloud-snow", high: 15, low: 8 }
      ]
    });
  });
});
