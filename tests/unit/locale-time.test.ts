import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE_SETTINGS,
  formatLocaleDate,
  formatLocaleDateTime,
  formatLocaleTime,
  resolveEffectiveLocale,
  type LocaleSettingsDto
} from "@moss/shared";

const pacific12: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};
const pacific24: LocaleSettingsDto = { ...pacific12, dateFormat: "24" };

describe("shared person-time formatters (#3390)", () => {
  const instant = "2026-10-11T17:15:00.000Z";

  it("shows an instant in the person's timezone and 12-hour clock", () => {
    expect(formatLocaleTime(instant, pacific12)).toBe("10:15 AM");
    expect(formatLocaleDateTime(instant, pacific12)).toBe("Oct 11, 2026, 10:15 AM");
    expect(formatLocaleDate(instant, pacific12)).toBe("Oct 11, 2026");
  });

  it("follows the 24-hour choice", () => {
    expect(formatLocaleTime(instant, pacific24)).toBe("10:15");
    expect(formatLocaleTime("2026-10-11T23:05:00.000Z", pacific24)).toBe("16:05");
  });
});

describe("resolveEffectiveLocale", () => {
  it("keeps a valid saved locale", () => {
    expect(resolveEffectiveLocale(pacific24)).toEqual(pacific24);
  });

  it("gives the app default, not UTC, when nothing is saved", () => {
    expect(resolveEffectiveLocale(undefined)).toEqual(DEFAULT_LOCALE_SETTINGS);
    expect(resolveEffectiveLocale(null)).toEqual(DEFAULT_LOCALE_SETTINGS);
    expect(resolveEffectiveLocale([])).toEqual(DEFAULT_LOCALE_SETTINGS);
  });

  it("replaces each invalid part with its default", () => {
    expect(
      resolveEffectiveLocale({ timezone: "Mars/Olympus", region: "", dateFormat: "13" })
    ).toEqual(DEFAULT_LOCALE_SETTINGS);
    expect(resolveEffectiveLocale({ timezone: "Europe/Paris" })).toEqual({
      ...DEFAULT_LOCALE_SETTINGS,
      timezone: "Europe/Paris"
    });
  });
});
