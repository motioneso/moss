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
        current: { temperature_2m: 21.4, apparent_temperature: 20.1, weather_code: 0 }
      })
    })) as unknown as typeof fetch;

    await expect(fetchOpenMeteoForecast(1, 2, "metric", "Testville", fetchFn)).resolves.toEqual({
      temp: 21,
      feelsLike: 20,
      condition: "Clear sky",
      icon: "sun",
      location: "Testville",
      unit: "metric"
    });
  });
});
