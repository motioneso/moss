import { describe, expect, it } from "vitest";

import { resolveGoogleCalendarBase } from "../../packages/connectors/src/google-api-client.js";

const REAL = "https://www.googleapis.com/calendar/v3";
const FAKE = "http://127.0.0.1:4599/calendar/v3";

describe("resolveGoogleCalendarBase (#2775)", () => {
  it("defaults to the real Google address", () => {
    expect(resolveGoogleCalendarBase({})).toBe(REAL);
  });

  it("uses the test override outside production", () => {
    expect(
      resolveGoogleCalendarBase({
        NODE_ENV: "test",
        MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: `${FAKE}/`
      })
    ).toBe(FAKE);
    expect(
      resolveGoogleCalendarBase({
        NODE_ENV: "development",
        MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: FAKE
      })
    ).toBe(FAKE);
  });

  it("ignores the override in production", () => {
    expect(
      resolveGoogleCalendarBase({
        NODE_ENV: "production",
        MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: FAKE
      })
    ).toBe(REAL);
    expect(
      resolveGoogleCalendarBase({
        NODE_ENV: "production",
        JARVIS_TEST_GOOGLE_CALENDAR_BASE_URL: FAKE
      })
    ).toBe(REAL);
  });

  it("ignores the override when NODE_ENV is unset or not exactly test or development", () => {
    expect(resolveGoogleCalendarBase({ MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: FAKE })).toBe(REAL);
    for (const nodeEnv of ["Production", "staging", ""]) {
      expect(
        resolveGoogleCalendarBase({
          NODE_ENV: nodeEnv,
          MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: FAKE
        })
      ).toBe(REAL);
    }
  });

  it("ignores an empty or non-http value", () => {
    const base = { NODE_ENV: "test" };
    expect(resolveGoogleCalendarBase({ ...base, MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: "" })).toBe(
      REAL
    );
    expect(
      resolveGoogleCalendarBase({ ...base, MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: "file:///etc" })
    ).toBe(REAL);
    expect(
      resolveGoogleCalendarBase({ ...base, MOSS_TEST_GOOGLE_CALENDAR_BASE_URL: "nonsense" })
    ).toBe(REAL);
  });
});
