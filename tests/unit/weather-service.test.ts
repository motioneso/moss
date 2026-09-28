import { describe, expect, it, vi } from "vitest";

import { WeatherService } from "../../packages/weather/src/weather-service.js";

function stubLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

describe("WeatherService.getWeatherForUser", () => {
  it("degrades to null when Open-Meteo returns unparsable JSON", async () => {
    const preferencesRepo = {
      get: vi.fn(async () => ({ lat: 1, lon: 2, label: "Testville" })),
      getWithMetadata: vi.fn(),
      upsert: vi.fn()
    };
    const dataContext = {
      withDataContext: vi.fn((_ctx, work) => work({} as never))
    };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("bad json"))
    })) as unknown as typeof fetch;

    const service = new WeatherService({
      preferencesRepo: preferencesRepo as never,
      dataContext: dataContext as never,
      logger: stubLogger(),
      fetchFn
    });

    await expect(
      service.getWeatherForUser(
        { actorUserId: "00000000-0000-4000-8000-000000000001" },
        "1.2.3.4",
        "UTC"
      )
    ).resolves.toBeNull();
  });
});

describe("WeatherService background reads (#2766)", () => {
  it("skips IP lookup without a request address and reports today's high and low", async () => {
    const preferencesRepo = {
      get: vi.fn(async () => null),
      getWithMetadata: vi.fn(),
      upsert: vi.fn()
    };
    const dataContext = {
      withDataContext: vi.fn((_ctx, work) => work({} as never))
    };
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 57.6,
            apparent_temperature: 55.2,
            weather_code: 1,
            relative_humidity_2m: 60,
            dew_point_2m: 45,
            wind_speed_10m: 5
          },
          daily: {
            time: ["2026-06-13", "2026-06-14"],
            weather_code: [80, 3],
            temperature_2m_max: [64.4, 70],
            temperature_2m_min: [49.6, 52]
          }
        })
      };
    }) as unknown as typeof fetch;

    const service = new WeatherService({
      preferencesRepo: preferencesRepo as never,
      dataContext: dataContext as never,
      logger: stubLogger(),
      fetchFn
    });
    const data = await service.getWeatherForUser(
      { actorUserId: "00000000-0000-4000-8000-000000000001" },
      null,
      "America/Los_Angeles"
    );

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.open-meteo.com");
    expect(data?.location).toBe("Los Angeles, US");
    expect(data?.today).toEqual({ condition: "Light showers", high: 64, low: 50 });
    expect(data?.forecast.map((day) => day.date)).toEqual(["2026-06-14"]);
  });
});
