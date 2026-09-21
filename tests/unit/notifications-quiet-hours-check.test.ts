import { describe, expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";
import { isActorInQuietHours, type QuietHoursPort } from "@moss/notifications";

// #2570: a plain yes/no so the focus nudge can be dropped, not deferred, in quiet hours.

const DB = {} as unknown as DataContextDb;

function port(settings: unknown, localeTimezone: string | null = null): QuietHoursPort {
  return {
    getSettings: async () => settings,
    getLocaleTimezone: async () => localeTimezone
  };
}

describe("isActorInQuietHours", () => {
  const overnight = { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" };

  it("is true inside an overnight window and false outside it", async () => {
    expect(await isActorInQuietHours(DB, port(overnight), new Date("2026-09-21T23:30:00Z"))).toBe(
      true
    );
    expect(await isActorInQuietHours(DB, port(overnight), new Date("2026-09-21T03:00:00Z"))).toBe(
      true
    );
    expect(await isActorInQuietHours(DB, port(overnight), new Date("2026-09-21T12:00:00Z"))).toBe(
      false
    );
  });

  it("is false when quiet hours are off, missing or malformed (fails if it guesses true)", async () => {
    const now = new Date("2026-09-21T23:30:00Z");
    expect(await isActorInQuietHours(DB, port({ ...overnight, enabled: false }), now)).toBe(false);
    expect(await isActorInQuietHours(DB, port(null), now)).toBe(false);
    expect(
      await isActorInQuietHours(DB, port({ enabled: true, start: "25:99", end: "07:00" }), now)
    ).toBe(false);
  });

  it("uses the person's own timezone, falling back to their locale, then UTC", async () => {
    // 23:30 UTC is 19:30 in New York: outside a 22:00-07:00 window there, inside it in UTC.
    const noTimezone = { enabled: true, start: "22:00", end: "07:00", timezone: null };
    const now = new Date("2026-09-21T23:30:00Z");
    expect(
      await isActorInQuietHours(DB, port({ ...overnight, timezone: "America/New_York" }), now)
    ).toBe(false);
    expect(await isActorInQuietHours(DB, port(noTimezone, "America/New_York"), now)).toBe(false);
    expect(await isActorInQuietHours(DB, port(noTimezone, null), now)).toBe(true);
  });
});
