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
