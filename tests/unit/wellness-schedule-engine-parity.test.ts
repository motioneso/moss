import { describe, expect, it } from "vitest";

import { computeSchedule } from "@moss/wellness";
import type { Medication, MedicationLog } from "@moss/db";

/**
 * Golden-output safety net for #1953 (switching computeSchedule to the shared occurrence
 * engine from #1950). Every expected value here was computed against the pre-switch
 * (private date math) computeSchedule and must still hold after the switch, so a real
 * behavior drift fails this file instead of shipping silently.
 */
describe("computeSchedule matches its pre-engine-switch output", () => {
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

  function times(medication: Medication, logs: readonly MedicationLog[], date: Date): string[] {
    return computeSchedule([medication], logs, date)
      .filter((s) => !s.asNeeded)
      .map((s) => s.scheduledFor!.slice(11, 16));
  }

  it("once_daily / times_per_day: one slot per schedule_times entry", () => {
    expect(times(med({ schedule_times: ["08:00", "20:00"] }), [], monday)).toEqual([
      "08:00",
      "20:00"
    ]);
  });

  it("specific_weekdays: only fires on a listed weekday", () => {
    const onListedDay = med({
      frequency_type: "specific_weekdays",
      weekdays: [1],
      schedule_times: ["09:00"]
    });
    const onOtherDay = med({
      frequency_type: "specific_weekdays",
      weekdays: [2],
      schedule_times: ["09:00"]
    });
    expect(times(onListedDay, [], monday)).toEqual(["09:00"]);
    expect(times(onOtherDay, [], monday)).toEqual([]);
  });

  it("every_n_hours: fixed daily times from interval, anchored at midnight when no schedule_time", () => {
    const m = med({ frequency_type: "every_n_hours", interval_hours: 6, schedule_times: null });
    expect(times(m, [], monday)).toEqual(["00:00", "06:00", "12:00", "18:00"]);
  });

  it("every_n_hours: anchored at the first schedule_time when provided", () => {
    const m = med({
      frequency_type: "every_n_hours",
      interval_hours: 8,
      schedule_times: ["06:00"]
    });
    expect(times(m, [], monday)).toEqual(["06:00", "14:00", "22:00"]);
  });

  it("every_n_hours: no interval configured yields no slots (never invisible-crash, just empty)", () => {
    const m = med({ frequency_type: "every_n_hours", interval_hours: null, schedule_times: null });
    expect(times(m, [], monday)).toEqual([]);
  });

  it("cyclical: eligible only inside the on-phase, counted from its anchor date", () => {
    const m = med({
      frequency_type: "cyclical",
      cycle_anchor_date: "2026-06-15",
      cycle_days_on: 2,
      cycle_days_off: 3,
      schedule_times: ["07:00"]
    });
    // Day 0 and 1 (Mon, Tue) are "on"; day 2-4 (Wed-Fri) are "off"; day 5 (Sat) is "on" again.
    expect(times(m, [], new Date("2026-06-15T00:00:00.000Z"))).toEqual(["07:00"]); // on
    expect(times(m, [], new Date("2026-06-16T00:00:00.000Z"))).toEqual(["07:00"]); // on
    expect(times(m, [], new Date("2026-06-17T00:00:00.000Z"))).toEqual([]); // off
    expect(times(m, [], new Date("2026-06-20T00:00:00.000Z"))).toEqual(["07:00"]); // on again
  });

  it("cyclical: never eligible before its anchor date", () => {
    const m = med({
      frequency_type: "cyclical",
      cycle_anchor_date: "2026-06-15",
      cycle_days_on: 2,
      cycle_days_off: 3,
      schedule_times: ["07:00"]
    });
    expect(times(m, [], new Date("2026-06-14T00:00:00.000Z"))).toEqual([]);
  });

  it("cyclical: a missing anchor or days_on falls back to always-eligible (matches the old default)", () => {
    const missingAnchor = med({
      frequency_type: "cyclical",
      cycle_anchor_date: null,
      cycle_days_on: 3,
      cycle_days_off: 2,
      schedule_times: ["07:00"]
    });
    const missingDaysOn = med({
      frequency_type: "cyclical",
      cycle_anchor_date: "2026-06-01",
      cycle_days_on: null,
      cycle_days_off: 2,
      schedule_times: ["07:00"]
    });
    expect(times(missingAnchor, [], monday)).toEqual(["07:00"]);
    expect(times(missingDaysOn, [], monday)).toEqual(["07:00"]);
  });

  it("as_needed: a single PRN affordance, never a fixed slot", () => {
    const slots = computeSchedule([med({ frequency_type: "as_needed" })], [], monday);
    expect(slots.length).toBe(1);
    expect(slots[0]?.asNeeded).toBe(true);
  });

  it("logging a dose does not change any other day's slots", () => {
    const m = med({ id: "mx", schedule_times: ["08:00"] });
    const scheduledFor = new Date("2026-06-15T08:00:00.000Z");
    const log: MedicationLog = {
      id: "l1",
      medication_id: "mx",
      owner_user_id: "u1",
      status: "taken",
      dose: null,
      prn_reason: null,
      scheduled_for: scheduledFor,
      logged_at: scheduledFor,
      created_at: scheduledFor
    } as MedicationLog;

    const loggedDay = computeSchedule([m], [log], monday);
    expect(loggedDay.find((s) => !s.asNeeded)?.status).toBe("taken");

    const nextDay = computeSchedule([m], [log], new Date("2026-06-16T00:00:00.000Z"));
    expect(nextDay.find((s) => !s.asNeeded)?.status).toBe("pending");
  });
});
