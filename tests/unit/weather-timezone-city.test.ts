import { describe, expect, it } from "vitest";

import {
  TIMEZONE_CITY_FALLBACK,
  lookupCityForTimeZone
} from "../../packages/weather/src/timezone-city.js";

describe("lookupCityForTimeZone", () => {
  it("returns the table entry for a known IANA zone", () => {
    expect(lookupCityForTimeZone("Europe/London")).toEqual(TIMEZONE_CITY_FALLBACK["Europe/London"]);
  });

  it("returns null for an unrecognized zone", () => {
    expect(lookupCityForTimeZone("Etc/Unknown")).toBeNull();
  });

  it("does not fuzzy-match a similar but different zone id", () => {
    expect(lookupCityForTimeZone("America/new_york")).toBeNull();
  });
});

describe("TIMEZONE_CITY_FALLBACK", () => {
  const entries = Object.entries(TIMEZONE_CITY_FALLBACK);

  it("has a reasonable number of curated entries", () => {
    expect(entries.length).toBeGreaterThanOrEqual(50);
    expect(entries.length).toBeLessThanOrEqual(70);
  });

  it("every entry has valid bounded coordinates and a non-empty label", () => {
    for (const [zone, entry] of entries) {
      expect(entry.lat, `${zone} lat`).toBeGreaterThanOrEqual(-90);
      expect(entry.lat, `${zone} lat`).toBeLessThanOrEqual(90);
      expect(entry.lon, `${zone} lon`).toBeGreaterThanOrEqual(-180);
      expect(entry.lon, `${zone} lon`).toBeLessThanOrEqual(180);
      expect(entry.label.trim().length, `${zone} label`).toBeGreaterThan(0);
    }
  });
});
