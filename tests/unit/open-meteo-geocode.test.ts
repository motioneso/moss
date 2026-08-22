import { describe, expect, it, vi } from "vitest";

import {
  searchOpenMeteoLocations,
  WeatherLocationSearchUnavailableError
} from "../../packages/weather/src/open-meteo-geocode.js";

describe("searchOpenMeteoLocations", () => {
  it("returns an empty array when the provider has no results", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({})
    })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("asdfqwerty", fetchFn)).resolves.toEqual([]);
  });

  it("returns a single candidate for a unique match", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            latitude: 32.7157,
            longitude: -117.1611,
            name: "San Diego",
            admin1: "California",
            country: "United States"
          }
        ]
      })
    })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("San Diego", fetchFn)).resolves.toEqual([
      { lat: 32.7157, lon: -117.1611, label: "San Diego, California, United States" }
    ]);
  });

  it("returns multiple candidates for an ambiguous match", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            latitude: 39.7817,
            longitude: -89.6501,
            name: "Springfield",
            admin1: "Illinois",
            country: "United States"
          },
          {
            latitude: 37.2153,
            longitude: -93.2982,
            name: "Springfield",
            admin1: "Missouri",
            country: "United States"
          }
        ]
      })
    })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("Springfield", fetchFn)).resolves.toEqual([
      { lat: 39.7817, lon: -89.6501, label: "Springfield, Illinois, United States" },
      { lat: 37.2153, lon: -93.2982, label: "Springfield, Missouri, United States" }
    ]);
  });

  it("omits the admin1 segment from the label when absent", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [{ latitude: 35.6762, longitude: 139.6503, name: "Tokyo", country: "Japan" }]
      })
    })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("Tokyo", fetchFn)).resolves.toEqual([
      { lat: 35.6762, lon: 139.6503, label: "Tokyo, Japan" }
    ]);
  });

  it("caps the returned candidates to the given limit", async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      latitude: i,
      longitude: i,
      name: `Place ${i}`,
      country: "Testland"
    }));
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results })
    })) as unknown as typeof fetch;

    const candidates = await searchOpenMeteoLocations("Place", fetchFn, 3);
    expect(candidates).toHaveLength(3);
  });

  it("throws WeatherLocationSearchUnavailableError on a non-ok HTTP status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("San Diego", fetchFn)).rejects.toBeInstanceOf(
      WeatherLocationSearchUnavailableError
    );
  });

  it("throws WeatherLocationSearchUnavailableError when the response body is not valid JSON", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("bad json"))
    })) as unknown as typeof fetch;

    await expect(searchOpenMeteoLocations("San Diego", fetchFn)).rejects.toBeInstanceOf(
      WeatherLocationSearchUnavailableError
    );
  });
});
