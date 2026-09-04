import { describe, expect, it, vi } from "vitest";

import { reverseGeocodeLocation } from "../../packages/weather/src/nominatim-reverse.js";
import { WeatherLocationSearchUnavailableError } from "../../packages/weather/src/open-meteo-geocode.js";

describe("reverseGeocodeLocation", () => {
  it("labels the browser's own coordinates with city, state and country", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        address: { city: "San Diego", state: "California", country: "United States" }
      })
    })) as unknown as typeof fetch;

    await expect(reverseGeocodeLocation(32.7157, -117.1611, fetchFn)).resolves.toEqual({
      lat: 32.7157,
      lon: -117.1611,
      label: "San Diego, California, United States"
    });
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const [url, init] = calls[0] ?? ["", {}];
    expect(url).toContain("nominatim.openstreetmap.org/reverse");
    expect(url).toContain("lat=32.7157");
    expect((init.headers as Record<string, string>)["user-agent"]).toContain("Moss");
  });

  it("falls back through town and village when there is no city", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ address: { village: "Hamlet", country: "Ireland" } })
    })) as unknown as typeof fetch;

    await expect(reverseGeocodeLocation(53, -8, fetchFn)).resolves.toMatchObject({
      label: "Hamlet, Ireland"
    });
  });

  it("uses rounded coordinates when the provider has no address", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: "Unable to geocode" })
    })) as unknown as typeof fetch;

    await expect(reverseGeocodeLocation(0, 0, fetchFn)).resolves.toMatchObject({
      label: "0.000, 0.000"
    });
  });

  it("reports the provider as unavailable on a non-OK status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    await expect(reverseGeocodeLocation(1, 1, fetchFn)).rejects.toBeInstanceOf(
      WeatherLocationSearchUnavailableError
    );
  });
});
