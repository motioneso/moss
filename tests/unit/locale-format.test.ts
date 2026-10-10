import { describe, expect, it } from "vitest";

import { localDay, type LocaleSettingsDto } from "@moss/shared";
import {
  formatClockTime,
  formatDate,
  formatDateTime,
  formatTime
} from "../../apps/web/src/locale/locale-format.js";

const newYork12: LocaleSettingsDto = {
  timezone: "America/New_York",
  region: "en-US",
  dateFormat: "12"
};
const tokyo24: LocaleSettingsDto = {
  timezone: "Asia/Tokyo",
  region: "en-US",
  dateFormat: "24"
};
const tokyo12: LocaleSettingsDto = { timezone: "Asia/Tokyo", region: "en-US", dateFormat: "12" };
const utc24: LocaleSettingsDto = { timezone: "UTC", region: "en-US", dateFormat: "24" };
const utc12: LocaleSettingsDto = { timezone: "UTC", region: "en-US", dateFormat: "12" };

describe("locale-format", () => {
  it("renders the same instant on different calendar days per timezone", () => {
    // 01:30 UTC is the previous evening in New York but the same morning in Tokyo.
    const instant = "2026-01-15T01:30:00Z";
    expect(formatDate(instant, newYork12)).toBe("Jan 14, 2026");
    expect(formatDate(instant, tokyo24)).toBe("Jan 15, 2026");
  });

  it("honours the 12/24-hour preference", () => {
    const instant = "2026-01-15T13:30:00Z";
    expect(formatTime(instant, utc12)).toBe("1:30 PM");
    expect(formatTime(instant, utc24)).toBe("13:30");
  });

  it("tracks daylight-saving offsets within a zone", () => {
    // Same wall-clock UTC hour, opposite sides of the US DST boundary.
    expect(formatTime("2026-01-01T16:00:00Z", newYork12)).toBe("11:00 AM"); // EST (UTC-5)
    expect(formatTime("2026-07-01T16:00:00Z", newYork12)).toBe("12:00 PM"); // EDT (UTC-4)
  });

  it("formats date + time together in the user's zone", () => {
    expect(formatDateTime("2026-01-15T13:30:00Z", tokyo24)).toBe("Jan 15, 2026, 22:30");
  });

  it("returns the raw input on an unparseable date without throwing", () => {
    expect(formatDate("not-a-date", utc24)).toBe("not-a-date");
    expect(formatDateTime("", utc24)).toBe("");
  });

  it("returns the raw input on an invalid timezone or region without throwing", () => {
    const badZone: LocaleSettingsDto = {
      timezone: "Not/ARealZone",
      region: "en-US",
      dateFormat: "24"
    };
    const badRegion: LocaleSettingsDto = {
      timezone: "UTC",
      region: "!!not-a-tag!!",
      dateFormat: "24"
    };
    const instant = "2026-01-15T00:00:00Z";
    expect(formatDate(instant, badZone)).toBe(instant);
    expect(formatDate(instant, badRegion)).toBe(instant);
  });

  it("derives a timezone-correct YYYY-MM-DD calendar key", () => {
    const instant = "2026-01-15T01:30:00Z";
    expect(localDay(instant, "America/New_York")).toBe("2026-01-14");
    expect(localDay(instant, "Asia/Tokyo")).toBe("2026-01-15");
  });
});

describe("formatClockTime", () => {
  it("renders a wall-clock HH:MM in the user's 12/24-hour preference without shifting zones", () => {
    expect(formatClockTime("21:00", newYork12)).toBe("9:00 PM");
    expect(formatClockTime("00:05", tokyo24)).toBe("00:05");
    expect(formatClockTime("21:00", utc24)).toBe("21:00");
    expect(formatClockTime("08:30", tokyo12)).toBe("8:30 AM");
  });

  it("returns the input unchanged when it is not an HH:MM clock", () => {
    expect(formatClockTime("", utc12)).toBe("");
    expect(formatClockTime("soon", utc12)).toBe("soon");
  });
});
