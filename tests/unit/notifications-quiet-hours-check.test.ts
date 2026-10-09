import { describe, expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";
import {
  computeDeferredUntil,
  isActorInQuietHours,
  type QuietHoursPort,
  type QuietHoursSettings
} from "@moss/notifications";

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

describe("computeDeferredUntil", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly now: string;
    readonly start: string;
    readonly end: string;
    readonly zone: string;
    readonly expected: string | null;
  }> = [
    {
      name: "uses the correct local overnight end in Chicago",
      now: "2026-10-09T03:30:00Z",
      start: "22:00",
      end: "07:00",
      zone: "America/Chicago",
      expected: "2026-10-09T12:00:00Z"
    },
    {
      name: "keeps a UTC+14 overnight end on its local date",
      now: "2026-10-08T09:30:00Z",
      start: "22:00",
      end: "07:00",
      zone: "Pacific/Kiritimati",
      expected: "2026-10-08T17:00:00Z"
    },
    {
      name: "uses the later end in a fall fold's first quiet portion",
      now: "2026-11-01T08:10:00Z",
      start: "22:00",
      end: "01:30",
      zone: "America/Los_Angeles",
      expected: "2026-11-01T09:30:00Z"
    },
    {
      name: "uses the later end in a fall fold's second quiet portion",
      now: "2026-11-01T09:10:00Z",
      start: "22:00",
      end: "01:30",
      zone: "America/Los_Angeles",
      expected: "2026-11-01T09:30:00Z"
    },
    {
      name: "does not extend wall membership across the first fold hour",
      now: "2026-11-01T08:45:00Z",
      start: "22:00",
      end: "01:30",
      zone: "America/Los_Angeles",
      expected: null
    },
    {
      name: "does not defer at the later exact end",
      now: "2026-11-01T09:30:00Z",
      start: "22:00",
      end: "01:30",
      zone: "America/Los_Angeles",
      expected: null
    }
  ];

  it.each(cases)("$name", ({ now, start, end, zone, expected }) => {
    const settings: QuietHoursSettings = { enabled: true, start, end, timezone: zone };
    expect(computeDeferredUntil(new Date(now), settings, zone)).toEqual(
      expected === null ? null : new Date(expected)
    );
  });

  it("releases at the first valid instant after a spring-gap end", () => {
    const settings: QuietHoursSettings = {
      enabled: true,
      start: "22:00",
      end: "02:30",
      timezone: "America/Los_Angeles"
    };

    expect(
      computeDeferredUntil(new Date("2026-03-08T09:45:00Z"), settings, "America/Los_Angeles")
    ).toEqual(new Date("2026-03-08T10:00:00Z"));
  });

  it("does not defer when quiet hours are disabled", () => {
    const settings: QuietHoursSettings = {
      enabled: false,
      start: "22:00",
      end: "07:00",
      timezone: "America/Chicago"
    };

    expect(
      computeDeferredUntil(new Date("2026-10-09T03:30:00Z"), settings, "America/Chicago")
    ).toBe(null);
  });
});
