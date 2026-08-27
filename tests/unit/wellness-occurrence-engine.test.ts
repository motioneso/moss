import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  type CycleSchedule,
  type DailySchedule,
  type EveryNDaysSchedule,
  type EveryNMonthsSchedule,
  type EveryNWeeksSchedule,
  type MonthlyDateSchedule,
  type MonthlyWeekdaySchedule,
  type ScheduleAnchor,
  type SelectedDaysSchedule
} from "../../packages/wellness/src/occurrence-engine.js";

const UTC_ANCHOR = (startDate: string, endDate: string | null = null): ScheduleAnchor => ({
  startDate,
  endDate,
  timeZone: "UTC"
});

function range(fromIso: string, toIso: string) {
  return { from: new Date(fromIso), to: new Date(toIso) };
}

function dates(occurrences: ReturnType<typeof expandOccurrences>): string[] {
  return occurrences.map((o) => `${o.date} ${o.time}`);
}

describe("expandOccurrences: daily", () => {
  it("emits every day for each dose time", () => {
    const schedule: DailySchedule = { family: "daily", doseTimes: ["08:00", "20:00"] };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-01-03T23:59:59Z")
    );
    expect(dates(result)).toEqual([
      "2026-01-01 08:00",
      "2026-01-01 20:00",
      "2026-01-02 08:00",
      "2026-01-02 20:00",
      "2026-01-03 08:00",
      "2026-01-03 20:00"
    ]);
  });

  it("never emits before the start date", () => {
    const schedule: DailySchedule = { family: "daily", doseTimes: ["09:00"] };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-02-05"),
      range("2026-02-01T00:00:00Z", "2026-02-06T23:59:59Z")
    );
    expect(dates(result)).toEqual(["2026-02-05 09:00", "2026-02-06 09:00"]);
  });

  it("stops at an inclusive end date", () => {
    const schedule: DailySchedule = { family: "daily", doseTimes: ["09:00"] };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-02-01", "2026-02-03"),
      range("2026-02-01T00:00:00Z", "2026-02-10T00:00:00Z")
    );
    expect(dates(result)).toEqual(["2026-02-01 09:00", "2026-02-02 09:00", "2026-02-03 09:00"]);
  });
});

describe("expandOccurrences: selected days", () => {
  it("only emits on the chosen weekdays", () => {
    // 2026-01-05 is a Monday.
    const schedule: SelectedDaysSchedule = {
      family: "selectedDays",
      weekdays: [1, 3, 5], // Mon, Wed, Fri
      doseTimes: ["07:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-05"),
      range("2026-01-05T00:00:00Z", "2026-01-11T23:59:59Z")
    );
    expect(dates(result)).toEqual(["2026-01-05 07:00", "2026-01-07 07:00", "2026-01-09 07:00"]);
  });
});

describe("expandOccurrences: every interval, days", () => {
  it("every other day from the anchor", () => {
    const schedule: EveryNDaysSchedule = {
      family: "everyInterval",
      unit: "days",
      interval: 2,
      doseTimes: ["10:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z")
    );
    expect(dates(result)).toEqual([
      "2026-01-01 10:00",
      "2026-01-03 10:00",
      "2026-01-05 10:00",
      "2026-01-07 10:00"
    ]);
  });
});

describe("expandOccurrences: every interval, weeks with weekdays", () => {
  it("respects both the weekday set and the week interval", () => {
    // Anchor is a Monday (2026-01-05); schedule fires every 2 weeks on Tue and Thu.
    const schedule: EveryNWeeksSchedule = {
      family: "everyInterval",
      unit: "weeks",
      interval: 2,
      weekdays: [2, 4], // Tue, Thu
      doseTimes: ["12:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-05"),
      range("2026-01-05T00:00:00Z", "2026-02-02T00:00:00Z")
    );
    // Week of Jan 5 (week 0): Tue 1/6, Thu 1/8. Week of Jan 12 (week 1): skipped.
    // Week of Jan 19 (week 2): Tue 1/20, Thu 1/22. Week of Jan 26 (week 3): skipped.
    expect(dates(result)).toEqual([
      "2026-01-06 12:00",
      "2026-01-08 12:00",
      "2026-01-20 12:00",
      "2026-01-22 12:00"
    ]);
  });
});

describe("expandOccurrences: every interval, months", () => {
  it("a dose on the 31st occurs only in months that have a 31st", () => {
    const schedule: EveryNMonthsSchedule = {
      family: "everyInterval",
      unit: "months",
      interval: 1,
      doseTimes: ["09:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-31"),
      range("2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z")
    );
    // Jan, Mar have 31 days; Feb (28, 2026 not leap) and Apr (30) do not.
    expect(dates(result)).toEqual(["2026-01-31 09:00", "2026-03-31 09:00"]);
  });

  it("spans a year boundary", () => {
    const schedule: EveryNMonthsSchedule = {
      family: "everyInterval",
      unit: "months",
      interval: 2,
      doseTimes: ["09:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-11-15"),
      range("2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z")
    );
    expect(dates(result)).toEqual(["2026-11-15 09:00", "2027-01-15 09:00"]);
  });
});

describe("expandOccurrences: monthly by date", () => {
  it("skips months missing that date, no clamping", () => {
    const schedule: MonthlyDateSchedule = {
      family: "monthly",
      kind: "date",
      dayOfMonth: 31,
      doseTimes: ["08:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z")
    );
    expect(dates(result)).toEqual(["2026-01-31 08:00", "2026-03-31 08:00"]);
  });

  it("handles last day of the month across leap and non-leap February", () => {
    const schedule: MonthlyDateSchedule = {
      family: "monthly",
      kind: "date",
      dayOfMonth: "last",
      doseTimes: ["08:00"]
    };
    const nonLeap = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-02-01"),
      range("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z")
    );
    expect(dates(nonLeap)).toEqual(["2026-02-28 08:00"]);

    const leap = expandOccurrences(
      schedule,
      UTC_ANCHOR("2028-02-01"),
      range("2028-02-01T00:00:00Z", "2028-03-01T00:00:00Z")
    );
    expect(dates(leap)).toEqual(["2028-02-29 08:00"]);
  });
});

describe("expandOccurrences: monthly by weekday position", () => {
  it("the third Tuesday of each month", () => {
    const schedule: MonthlyWeekdaySchedule = {
      family: "monthly",
      kind: "weekdayPosition",
      position: "third",
      weekday: 2, // Tuesday
      doseTimes: ["08:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z")
    );
    // Jan 2026: Tuesdays are 6, 13, 20, 27 -> third is 20. Feb 2026: Tuesdays 3, 10, 17, 24 -> third is 17.
    expect(dates(result)).toEqual(["2026-01-20 08:00", "2026-02-17 08:00"]);
  });

  it("the last Friday of each month, distinct from the fourth", () => {
    const schedule: MonthlyWeekdaySchedule = {
      family: "monthly",
      kind: "weekdayPosition",
      position: "last",
      weekday: 5, // Friday
      doseTimes: ["08:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")
    );
    // January 2026 has five Fridays: 2, 9, 16, 23, 30. Last is 30th, not the fourth (23rd).
    expect(dates(result)).toEqual(["2026-01-30 08:00"]);
  });
});

describe("expandOccurrences: cycle", () => {
  it("21 days on, 7 days off from the anchor", () => {
    const schedule: CycleSchedule = {
      family: "cycle",
      daysOn: 21,
      daysOff: 7,
      doseTimes: ["08:00"]
    };
    const result = expandOccurrences(
      schedule,
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-19T00:00:00Z", "2026-01-24T00:00:00Z")
    );
    // Day 0-20 on (Jan 1 - Jan 21), day 21-27 off (Jan 22 - Jan 28), day 28 on again (Jan 29).
    expect(dates(result)).toEqual(["2026-01-19 08:00", "2026-01-20 08:00", "2026-01-21 08:00"]);
  });
});

describe("expandOccurrences: as needed", () => {
  it("never produces a scheduled occurrence", () => {
    const result = expandOccurrences(
      { family: "asNeeded" },
      UTC_ANCHOR("2026-01-01"),
      range("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z")
    );
    expect(result).toEqual([]);
  });
});

describe("expandOccurrences: daylight saving", () => {
  const NY = "America/New_York";

  it("keeps a fixed local time through a daylight-saving change", () => {
    // 2026-03-08 is when US clocks spring forward in America/New_York.
    const schedule: DailySchedule = { family: "daily", doseTimes: ["09:00"] };
    const result = expandOccurrences(
      schedule,
      { startDate: "2026-03-07", endDate: "2026-03-09", timeZone: NY },
      range("2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z")
    );
    expect(result).toHaveLength(3);
    for (const occurrence of result) {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: NY,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(occurrence.at);
      expect(local).toBe("09:00");
    }
  });

  it("resolves a spring-forward gap time to the first valid instant after the gap", () => {
    // Clocks in America/New_York jump from 2:00 AM to 3:00 AM on 2026-03-08; 2:30 AM never happens.
    const schedule: DailySchedule = { family: "daily", doseTimes: ["02:30"] };
    const result = expandOccurrences(
      schedule,
      { startDate: "2026-03-08", endDate: "2026-03-08", timeZone: NY },
      range("2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z")
    );
    expect(result).toHaveLength(1);
    // 07:00 UTC is exactly 3:00 AM EDT, the instant the new offset takes effect.
    expect(result[0]!.at.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("resolves a repeated fall-back time to the earlier instant", () => {
    // Clocks in America/New_York fall back from 2:00 AM to 1:00 AM on 2026-11-01; 1:30 AM happens twice.
    const schedule: DailySchedule = { family: "daily", doseTimes: ["01:30"] };
    const result = expandOccurrences(
      schedule,
      { startDate: "2026-11-01", endDate: "2026-11-01", timeZone: NY },
      range("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")
    );
    expect(result).toHaveLength(1);
    // The earlier 1:30 AM is still EDT (UTC-4), i.e. 05:30 UTC. The later one would be 06:30 UTC.
    expect(result[0]!.at.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("every-N-hours-style elapsed spacing is unaffected: dose time itself stays fixed local clock", () => {
    // Regression guard: two consecutive daily 09:00 doses either side of a DST change are exactly
    // 24 civil hours apart in local time, even though the elapsed UTC duration differs.
    const schedule: DailySchedule = { family: "daily", doseTimes: ["09:00"] };
    const result = expandOccurrences(
      schedule,
      { startDate: "2026-03-07", endDate: "2026-03-09", timeZone: NY },
      range("2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z")
    );
    const beforeMs = result[0]!.at.getTime();
    const afterMs = result[1]!.at.getTime();
    // Spring-forward: elapsed UTC time between the two 9 AM locals is only 23 hours.
    expect(afterMs - beforeMs).toBe(23 * 60 * 60 * 1000);
  });
});
