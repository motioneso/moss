import { describe, expect, it } from "vitest";

import {
  normalizeOutlookCalendarLabel as normalize,
  outlookDisplayTimeZone,
  parseOutlookWeekHeader
} from "../../packages/connectors/src/outlook-calendar-source.js";

const zone = "America/Los_Angeles";

describe("Outlook rendered calendar source", () => {
  it("uses the occurrence identity independently of title and time", () => {
    const a = normalize(
      "source-occurrence",
      "Invented meeting, 10:30 PM to 11:00 PM, Wednesday, October 21, 2026, Busy",
      zone
    );
    const b = normalize(
      "source-occurrence",
      "Edited meeting, 9:30 PM to 10:00 PM, Wednesday, October 21, 2026, Busy",
      zone
    );
    expect(a.occurrenceKey).toBe(b.occurrenceKey);
    expect(a.startsAt).toBe("2026-10-22T05:30:00.000Z");
    expect(b.startsAt).toBe("2026-10-22T04:30:00.000Z");
  });

  it("keeps simultaneous events and recurring occurrences distinct", () => {
    const label = "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy";
    expect(normalize("a", label, zone).occurrenceKey).not.toBe(
      normalize("b", label, zone).occurrenceKey
    );
  });

  it("preserves commas in titles and removes a rendered charm prefix", () => {
    const a = normalize(
      "a",
      "Exam icon, Invented, meeting, 12 PM to 1 PM, Wednesday, October 21, 2026, Busy",
      zone
    );
    expect(a.title).toBe("Invented, meeting");
    expect(a.startsAt).toBe("2026-10-21T19:00:00.000Z");
  });

  it("converts one-day and inclusive multi-day all-day labels to exclusive dates", () => {
    const a = normalize(
      "a",
      "Invented day, all day event, Wednesday, October 21, 2026, Free",
      zone
    );
    const b = normalize(
      "b",
      "Invented days, all day event, Wednesday, October 21, 2026 to Friday, October 23, 2026, Free",
      zone
    );
    expect(a.startsAt).toBe("2026-10-21T00:00:00.000Z");
    expect(a.endsAt).toBe("2026-10-22T00:00:00.000Z");
    expect(b.endsAt).toBe("2026-10-24T00:00:00.000Z");
    expect(b.allDay).toBe(true);
  });

  it("preserves all-day calendar dates across DST", () => {
    const event = normalize(
      "a",
      "Invented days, all day event, Saturday, October 31, 2026 to Monday, November 2, 2026, Busy",
      zone
    );
    expect(event.startsAt).toBe("2026-10-31T00:00:00.000Z");
    expect(event.endsAt).toBe("2026-11-03T00:00:00.000Z");
  });

  it("uses the confirmed zone rather than its display name's fixed UTC offset", () => {
    expect(outlookDisplayTimeZone("(UTC-08:00) Pacific Time (US & Canada)")).toBe(zone);
    const event = normalize(
      "a",
      "Invented meeting, 10 AM to 11 AM, Monday, November 2, 2026, Busy",
      zone
    );
    expect(event.startsAt).toBe("2026-11-02T18:00:00.000Z");
    expect(() => outlookDisplayTimeZone("Unknown zone")).toThrow("source-changed");
  });

  it.each([
    "Invented meeting, 1:30 AM to 2:30 AM, Sunday, November 1, 2026, Busy",
    "Invented meeting, 2:30 AM to 3:30 AM, Sunday, March 8, 2026, Busy",
    "Invented meeting, 13 PM to 2 PM, Wednesday, October 21, 2026, Busy",
    "Invented meeting, 11 PM to 1 AM, Wednesday, October 21, 2026, Busy",
    "Invented meeting, 10 AM to 11 AM, Monday, February 30, 2026, Busy",
    "Unsupported label",
    "Invented, 10 AM to 11 AM, Wednesday, October 21, 2026, 1 PM to 2 PM, Wednesday, October 21, 2026, Busy"
  ])("refuses ambiguous or unsupported timing without echoing content", (label) => {
    expect(() => normalize("a", label, zone)).toThrow(/^partial$/);
  });

  it("requires an observed ID; title/time never become identity", () => {
    expect(() =>
      normalize("", "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy", zone)
    ).toThrow("partial");
  });

  it("checks the exact weekly range, including month and year boundaries", () => {
    const suffix = ", Jump to a specific date or date range.";
    expect(parseOutlookWeekHeader("October 18–24, 2026" + suffix)).toEqual({
      start: "2026-10-18",
      end: "2026-10-25"
    });
    expect(parseOutlookWeekHeader("November 29 – December 5, 2026" + suffix)).toEqual({
      start: "2026-11-29",
      end: "2026-12-06"
    });
    expect(parseOutlookWeekHeader("December 27, 2026 – January 2, 2027" + suffix)).toEqual({
      start: "2026-12-27",
      end: "2027-01-03"
    });
    expect(() => parseOutlookWeekHeader("October 18–23, 2026" + suffix)).toThrow("source-changed");
  });
});

describe("Outlook source date validation", () => {
  it("rejects a weekday/date disagreement and invalid zones for all-day events", () => {
    expect(() =>
      normalize("a", "Invented, all day event, Thursday, October 21, 2026, Busy", zone)
    ).toThrow("partial");
    expect(() =>
      normalize("a", "Invented, all day event, Wednesday, October 21, 2026, Busy", "Unknown/Zone")
    ).toThrow("partial");
  });
});
