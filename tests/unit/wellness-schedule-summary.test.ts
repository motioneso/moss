import { describe, expect, it } from "vitest";

import { describeSchedule, nextDoses } from "@moss/wellness";
import type { Medication } from "@moss/db";

/**
 * #1969 — plain-language schedule summary and next-three-doses preview. Covers every
 * frequency_type and confirms both functions respect medication.time_zone.
 */
describe("describeSchedule and nextDoses", () => {
  const monday = new Date("2026-06-15T00:00:00.000Z"); // ISO weekday 1

  function med(overrides: Partial<Medication>): Medication {
    return {
      id: "m1",
      owner_user_id: "u1",
      name: "Med",
      dosage: null,
      form: null,
      frequency_type: "once_daily",
      times_per_day: null,
      interval_hours: null,
      weekdays: null,
      schedule_times: null,
      cycle_days_on: null,
      cycle_days_off: null,
      cycle_anchor_date: null,
      active: true,
      notes: null,
      schedule_start_date: null,
      schedule_end_date: null,
      time_zone: null,
      interval_unit: null,
      interval_count: null,
      month_kind: null,
      month_day: null,
      month_day_is_last: false,
      month_weekday_position: null,
      month_weekday: null,
      created_at: monday,
      updated_at: monday,
      ...overrides
    } as Medication;
  }

  describe("describeSchedule", () => {
    it("once_daily: one time", () => {
      expect(describeSchedule(med({ schedule_times: ["08:00"] }))).toBe("Once a day, at 8:00 AM.");
    });

    it("times_per_day: three times, Oxford comma", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "times_per_day",
            times_per_day: 3,
            schedule_times: ["08:00", "14:00", "20:00"]
          })
        )
      ).toBe("3 times a day, at 8:00 AM, 2:00 PM, and 8:00 PM.");
    });

    it("times_per_day: two times, 'and' with no comma", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "times_per_day",
            times_per_day: 2,
            schedule_times: ["08:00", "20:00"]
          })
        )
      ).toBe("Twice a day, at 8:00 AM and 8:00 PM.");
    });

    it("specific_weekdays: two days listed in ISO order", () => {
      expect(
        describeSchedule(
          med({ frequency_type: "specific_weekdays", weekdays: [4, 1], schedule_times: ["09:00"] })
        )
      ).toBe("Every Monday and Thursday, at 9:00 AM.");
    });

    it("every_n_hours: interval plus anchor time", () => {
      expect(
        describeSchedule(
          med({ frequency_type: "every_n_hours", interval_hours: 6, schedule_times: ["08:00"] })
        )
      ).toBe("Every 6 hours, starting at 8:00 AM.");
    });

    it("cyclical: on/off days plus anchor date and time", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "cyclical",
            cycle_days_on: 2,
            cycle_days_off: 3,
            cycle_anchor_date: "2026-06-15",
            schedule_times: ["07:00"]
          })
        )
      ).toBe("2 days on, 3 days off, starting 15 June 2026, at 7:00 AM.");
    });

    it("every_interval/weeks: interval, weekday, start date and time", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "every_interval",
            interval_unit: "weeks",
            interval_count: 2,
            weekdays: [1],
            schedule_start_date: "2026-03-03",
            schedule_times: ["09:00"]
          })
        )
      ).toBe("Every 2 weeks on Monday, starting 3 March 2026, at 9:00 AM.");
    });

    it("every_interval/months: interval, start date and time", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "every_interval",
            interval_unit: "months",
            interval_count: 2,
            schedule_start_date: "2026-03-03",
            schedule_times: ["09:00"]
          })
        )
      ).toBe("Every 2 months, starting 3 March 2026, at 9:00 AM.");
    });

    it("every_interval/days: interval, start date and time", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "every_interval",
            interval_unit: "days",
            interval_count: 3,
            schedule_start_date: "2026-01-01",
            schedule_times: ["08:00"]
          })
        )
      ).toBe("Every 3 days, starting 1 January 2026, at 8:00 AM.");
    });

    it("monthly/date: numbered day of month", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "monthly",
            month_kind: "date",
            month_day: 15,
            schedule_start_date: "2026-01-01",
            schedule_times: ["08:00"]
          })
        )
      ).toBe("On the 15th of each month, at 8:00 AM.");
    });

    it("monthly/date: last day of month", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "monthly",
            month_kind: "date",
            month_day_is_last: true,
            schedule_start_date: "2026-01-01",
            schedule_times: ["08:00"]
          })
        )
      ).toBe("On the last day of each month, at 8:00 AM.");
    });

    it("monthly/weekdayPosition", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "monthly",
            month_kind: "weekdayPosition",
            month_weekday_position: "first",
            month_weekday: 1,
            schedule_start_date: "2026-01-01",
            schedule_times: ["08:00"]
          })
        )
      ).toBe("On the first Monday of each month, at 8:00 AM.");
    });

    it("as_needed", () => {
      expect(describeSchedule(med({ frequency_type: "as_needed" }))).toBe("As needed.");
    });

    it("appends an end date when the medication has one", () => {
      expect(
        describeSchedule(
          med({
            frequency_type: "every_interval",
            interval_unit: "days",
            interval_count: 3,
            schedule_start_date: "2026-01-01",
            schedule_end_date: "2026-09-01",
            schedule_times: ["08:00"]
          })
        )
      ).toBe("Every 3 days, starting 1 January 2026, at 8:00 AM, until 1 September 2026.");
    });

    it("respects a non-UTC time zone for the printed clock time", () => {
      // 08:00 civil time in America/New_York in June (EDT, UTC-4) should print as 8:00 AM,
      // not shift when formatted — this guards against an implementation that formats the
      // UTC instant directly instead of the stored civil time.
      expect(
        describeSchedule(med({ schedule_times: ["08:00"], time_zone: "America/New_York" }))
      ).toBe("Once a day, at 8:00 AM.");
    });
  });

  describe("nextDoses", () => {
    it("once_daily: next three doses, one per day, at the expected UTC instants", () => {
      const m = med({ schedule_times: ["08:00"] });
      const result = nextDoses(m, monday, 3);
      expect(result.map((d) => d.toISOString())).toEqual([
        "2026-06-15T08:00:00.000Z",
        "2026-06-16T08:00:00.000Z",
        "2026-06-17T08:00:00.000Z"
      ]);
    });

    it("defaults to 3 when count is omitted", () => {
      const m = med({ schedule_times: ["08:00"] });
      expect(nextDoses(m, monday).length).toBe(3);
    });

    it("as_needed: no occurrences", () => {
      expect(nextDoses(med({ frequency_type: "as_needed" }), monday)).toEqual([]);
    });

    it("a schedule that never fires returns an empty array, not an error", () => {
      const m = med({
        frequency_type: "specific_weekdays",
        weekdays: [],
        schedule_times: ["09:00"]
      });
      expect(nextDoses(m, monday)).toEqual([]);
    });

    it("respects medication.time_zone: the UTC instant shifts by the zone's offset", () => {
      // 08:00 civil time in America/New_York in June is UTC-4 (EDT), so the dose is due at
      // 12:00 UTC, not 08:00 UTC as a naive-UTC reading would produce.
      const m = med({ schedule_times: ["08:00"], time_zone: "America/New_York" });
      const [first] = nextDoses(m, monday, 1);
      expect(first?.toISOString()).toBe("2026-06-15T12:00:00.000Z");
    });
  });
});
