// #1723 item 1. These helpers exist so that every module does not re-derive local-day arithmetic,
// and the cases below are the ones a re-derivation gets wrong: the evening-in-a-western-zone case
// that puts a record on tomorrow, and the two days a year that are not 24 hours long.
import { describe, expect, it } from "vitest";

import {
  addLocalDays,
  isValidTimeZone,
  localDayKey,
  localDayRange,
  resolveLocalDay,
  StrictLocalWallClockError,
  strictLocalWallClockToInstant,
  timeZoneOffsetMinutes,
  todayLocalDayKey
} from "@moss/module-sdk";

const LA = "America/Los_Angeles";
const AUCKLAND = "Pacific/Auckland";

describe("localDayKey", () => {
  // The bug this whole module exists to prevent: 8pm on the 14th in Los Angeles is already the
  // 15th in UTC, so anything reading the day off a UTC ISO string files it under tomorrow and the
  // user sees an empty day plus a mystery entry.
  it("uses the user's day, not the server's", () => {
    const evening = new Date("2026-03-15T03:30:00Z");
    expect(localDayKey(evening, LA)).toBe("2026-03-14");
    expect(localDayKey(evening, "UTC")).toBe("2026-03-15");
  });

  it("gets the day right ahead of UTC too", () => {
    expect(localDayKey(new Date("2026-03-14T20:00:00Z"), AUCKLAND)).toBe("2026-03-15");
  });

  // A malformed zone arrives from a request header. Answering with the wrong day beats erroring
  // out of a request that is otherwise fine.
  it("falls back to UTC on an unrecognised zone rather than throwing", () => {
    expect(localDayKey(new Date("2026-03-15T03:30:00Z"), "Mars/Olympus")).toBe("2026-03-15");
  });
});

describe("isValidTimeZone", () => {
  it.each([LA, "UTC", AUCKLAND])("accepts %s", (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(["", "   ", "Mars/Olympus", "Not/AZone"])("rejects %o", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });

  // Documenting real behaviour, not endorsing it: Intl accepts the legacy three-letter aliases, so
  // this returns true. A module that wants to require a proper IANA identifier has to check for
  // itself; "valid" here means "this runtime will format with it".
  it("accepts the legacy three-letter aliases Intl still recognises", () => {
    expect(isValidTimeZone("PST")).toBe(true);
  });
});

describe("timeZoneOffsetMinutes", () => {
  // Computed per instant, not per zone. A fixed-offset table gets one of these two wrong.
  it("reflects the offset in force at that instant, across a DST change", () => {
    expect(timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), LA)).toBe(-480);
    expect(timeZoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), LA)).toBe(-420);
  });
});

describe("resolveLocalDay", () => {
  it("returns the day and the offset that was in force, for persisting together", () => {
    expect(resolveLocalDay(new Date("2026-07-15T03:30:00Z"), LA)).toEqual({
      localDate: "2026-07-14",
      timezoneOffsetMinutes: -420
    });
  });
});

describe("localDayRange", () => {
  it("covers an ordinary day as a half-open range", () => {
    const { start, end } = localDayRange("2026-07-15", LA);
    expect(start.toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  // 2026-03-08 in Los Angeles is 23 hours long — the clocks go forward at 2am. Adding 24 hours to
  // the start would put the end an hour into the next day and pull the next day's first record in.
  it("gives a 23-hour range on the day the clocks go forward", () => {
    const { start, end } = localDayRange("2026-03-08", LA);
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  // 2026-11-01 is 25 hours long. Here a fixed 24 hours would end an hour early and silently drop
  // the last hour of the user's records.
  it("gives a 25-hour range on the day the clocks go back", () => {
    const { start, end } = localDayRange("2026-11-01", LA);
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("puts an evening record inside its own day's range", () => {
    const evening = new Date("2026-03-15T03:30:00Z");
    const { start, end } = localDayRange(localDayKey(evening, LA), LA);
    expect(evening.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(evening.getTime()).toBeLessThan(end.getTime());
  });

  // A bad date string would otherwise return a plausible-looking range for the wrong day, which is
  // worse than an error because nothing anywhere reports it.
  it.each(["2026-7-15", "15/07/2026", "today", ""])("refuses the malformed date %o", (bad) => {
    expect(() => localDayRange(bad, LA)).toThrow(/YYYY-MM-DD/);
  });
});

describe("addLocalDays", () => {
  it("crosses a month boundary", () => {
    expect(addLocalDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses a year boundary backwards", () => {
    expect(addLocalDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  // Pure calendar arithmetic: it must not shift by 23 or 25 hours on a DST day.
  it("adds a calendar day, not 24 hours, across a DST change", () => {
    expect(addLocalDays("2026-03-08", 1)).toBe("2026-03-09");
  });
});

describe("strictLocalWallClockToInstant", () => {
  // #1869 exit criterion 6: the exact instant, day, and offset a real Food write needs to persist
  // together.
  it("converts an ordinary local wall clock to the exact UTC instant", () => {
    expect(strictLocalWallClockToInstant("2026-08-22T20:14:00", LA).toISOString()).toBe(
      "2026-08-23T03:14:00.000Z"
    );
  });

  it("accepts a local wall clock without seconds", () => {
    expect(strictLocalWallClockToInstant("2026-08-22T20:14", LA).toISOString()).toBe(
      "2026-08-23T03:14:00.000Z"
    );
  });

  it("accepts fractional seconds", () => {
    expect(strictLocalWallClockToInstant("2026-08-22T20:14:00.250", LA).toISOString()).toBe(
      "2026-08-23T03:14:00.250Z"
    );
  });

  it("resolves ahead of UTC too", () => {
    expect(strictLocalWallClockToInstant("2026-08-23T09:00:00", AUCKLAND).toISOString()).toBe(
      "2026-08-22T21:00:00.000Z"
    );
  });

  it.each([
    "2026-08-22T20:14:00Z",
    "2026-08-22T20:14:00-07:00",
    "not-a-date",
    "2026-08-22 20:14:00"
  ])("rejects syntax it does not own, including offset-bearing input: %s", (input) => {
    expect(() => strictLocalWallClockToInstant(input, LA)).toThrow(StrictLocalWallClockError);
    try {
      strictLocalWallClockToInstant(input, LA);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StrictLocalWallClockError);
      expect((error as StrictLocalWallClockError).reason).toBe("invalid-syntax");
    }
  });

  it("rejects a calendar date that does not exist", () => {
    expect(() => strictLocalWallClockToInstant("2026-02-30T10:00:00", LA)).toThrow(
      StrictLocalWallClockError
    );
  });

  it("rejects an unrecognised time zone", () => {
    try {
      strictLocalWallClockToInstant("2026-08-22T20:14:00", "Mars/Olympus");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StrictLocalWallClockError);
      expect((error as StrictLocalWallClockError).reason).toBe("invalid-timezone");
    }
  });

  // 2026-03-08 is the day Los Angeles clocks jump from 2am straight to 3am: 2:30am never happens.
  it("rejects a spring-forward gap instead of guessing an instant", () => {
    try {
      strictLocalWallClockToInstant("2026-03-08T02:30:00", LA);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StrictLocalWallClockError);
      expect((error as StrictLocalWallClockError).reason).toBe("dst-gap");
    }
  });

  // 2026-11-01 is the day Los Angeles clocks fall back from 2am to 1am: 1:30am happens twice, an
  // hour apart, and there is no correct answer without an explicit offset.
  it("rejects a fall-back fold instead of picking the earlier or later instant", () => {
    try {
      strictLocalWallClockToInstant("2026-11-01T01:30:00", LA);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StrictLocalWallClockError);
      expect((error as StrictLocalWallClockError).reason).toBe("dst-fold");
    }
  });

  it("resolves the last unambiguous instant right before the fold begins", () => {
    expect(strictLocalWallClockToInstant("2026-11-01T00:59:00", LA).toISOString()).toBe(
      "2026-11-01T07:59:00.000Z"
    );
  });

  it("resolves the first unambiguous instant right after the fold ends", () => {
    expect(strictLocalWallClockToInstant("2026-11-01T02:00:00", LA).toISOString()).toBe(
      "2026-11-01T10:00:00.000Z"
    );
  });
});

describe("todayLocalDayKey", () => {
  it("reads the current instant in the user's zone", () => {
    const now = new Date("2026-03-15T03:30:00Z");
    expect(todayLocalDayKey(LA, now)).toBe("2026-03-14");
    expect(todayLocalDayKey(AUCKLAND, now)).toBe("2026-03-15");
  });
});
