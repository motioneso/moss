import { describe, expect, it } from "vitest";

import { computeSchedule, nextDoses } from "@moss/wellness";
import type { Medication } from "@moss/db";

// #3217 DOM-009 / DOM-015: a requested civil date uses the medication's own time zone, and an
// every-N-hours schedule keeps its interval across midnight.
describe("schedule time zone and every-N-hours", () => {
  const base = new Date("2026-10-01T00:00:00.000Z");

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
      created_at: base,
      updated_at: base,
      ...overrides
    } as Medication;
  }

  const monthlyLa = med({
    frequency_type: "monthly",
    month_kind: "date",
    month_day: 9,
    schedule_times: ["21:00"],
    schedule_start_date: "2026-01-01" as unknown as Medication["schedule_start_date"],
    time_zone: "America/Los_Angeles"
  });

  it("DOM-009: a local evening monthly dose lands on its own local date", () => {
    const oct9 = computeSchedule([monthlyLa], [], new Date("2026-10-09T00:00:00.000Z"));
    const oct10 = computeSchedule([monthlyLa], [], new Date("2026-10-10T00:00:00.000Z"));
    expect(oct9.map((s) => s.scheduledFor)).toEqual(["2026-10-10T04:00:00.000Z"]);
    expect(oct10).toEqual([]);
  });

  it("WEB-30: a slot carries the medication's local clock time", () => {
    const m = med({
      frequency_type: "monthly",
      month_kind: "date",
      month_day: 9,
      schedule_times: ["08:00"],
      schedule_start_date: "2026-01-01" as unknown as Medication["schedule_start_date"],
      time_zone: "America/Los_Angeles"
    });
    const [slot] = computeSchedule([m], [], new Date("2026-10-09T00:00:00.000Z"));
    expect(slot).toMatchObject({ scheduledFor: "2026-10-09T15:00:00.000Z", localTime: "08:00" });
  });

  it("WEB-30: a stored time with seconds still shows as hours and minutes", () => {
    const m = med({
      frequency_type: "monthly",
      month_kind: "date",
      month_day: 9,
      schedule_times: ["21:00:00"],
      schedule_start_date: "2026-01-01" as unknown as Medication["schedule_start_date"],
      time_zone: "America/Los_Angeles"
    });
    const [slot] = computeSchedule([m], [], new Date("2026-10-09T00:00:00.000Z"));
    expect(slot?.localTime).toBe("21:00");
  });

  it("DOM-015: every 8 hours anchored at 20:00 gives 04:00, 12:00 and 20:00", () => {
    const m = med({
      frequency_type: "every_n_hours",
      interval_hours: 8,
      schedule_times: ["20:00"]
    });
    const times = computeSchedule([m], [], base).map((s) => s.scheduledFor!.slice(11, 16));
    expect(times).toEqual(["04:00", "12:00", "20:00"]);
  });

  it("DOM-015: the next-doses preview keeps the interval across midnight", () => {
    const m = med({
      frequency_type: "every_n_hours",
      interval_hours: 8,
      schedule_times: ["20:00"]
    });
    const next = nextDoses(m, new Date("2026-10-01T20:30:00.000Z"), 3).map((d) => d.toISOString());
    expect(next).toEqual([
      "2026-10-02T04:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-02T20:00:00.000Z"
    ]);
  });
});
