import { describe, expect, it } from "vitest";

import { computeSchedule } from "@moss/wellness";
import type { Medication } from "@moss/db";

/**
 * #1968 — every schedule type can now carry a start date and an optional end date, and a
 * medication must produce no dose outside that window. The window is applied as a day-level
 * clamp in computeSchedule, deliberately NOT by feeding the start date into the occurrence
 * engine's anchor: for a cycle schedule the anchor is `cycle_anchor_date` and it decides which
 * days are "on" days, so substituting a different date would shift the whole on/off pattern.
 * The last case below is the regression guard for exactly that.
 */
describe("computeSchedule honours the stored start/end window (#1968)", () => {
  const anchorDay = new Date("2026-06-15T00:00:00.000Z"); // Monday

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
      reminders_enabled: false,
      created_at: anchorDay,
      updated_at: anchorDay,
      ...overrides
    } as Medication;
  }

  function slotTimes(medication: Medication, date: Date): string[] {
    return computeSchedule([medication], [], date)
      .filter((slot) => !slot.asNeeded)
      .map((slot) => slot.scheduledFor!.slice(11, 16));
  }

  const today = new Date("2026-06-15T00:00:00.000Z");

  it("a daily medication that starts tomorrow produces no slot today", () => {
    const startsTomorrow = med({
      schedule_times: ["08:00"],
      schedule_start_date: "2026-06-16"
    });
    expect(slotTimes(startsTomorrow, today)).toEqual([]);
    // ...and still fires on its own start day, so the clamp is a window, not a block.
    expect(slotTimes(startsTomorrow, new Date("2026-06-16T00:00:00.000Z"))).toEqual(["08:00"]);
  });

  it("a daily medication that ended yesterday produces no slot today", () => {
    const endedYesterday = med({
      schedule_times: ["08:00"],
      schedule_end_date: "2026-06-14"
    });
    expect(slotTimes(endedYesterday, today)).toEqual([]);
    // The final day of the window is inclusive.
    expect(slotTimes(endedYesterday, new Date("2026-06-14T00:00:00.000Z"))).toEqual(["08:00"]);
  });

  it("a cycle medication with a later start date keeps the same on/off days", () => {
    // Anchor 2026-06-01, 3 days on then 3 days off. Counting from the anchor, the "on" days
    // are Jun 1-3, 7-9, 13-15, 19-21. Adding a start date of Jun 5 must only hide the days
    // before Jun 5 — it must not become the new phase origin, which would make Jun 5-7 the
    // "on" block and shift every later block with it.
    const withoutStartDate = med({
      frequency_type: "cyclical",
      cycle_days_on: 3,
      cycle_days_off: 3,
      cycle_anchor_date: "2026-06-01",
      schedule_times: ["09:00"]
    });
    const withStartDate = med({
      ...withoutStartDate,
      schedule_start_date: "2026-06-05"
    } as Partial<Medication>);

    const onDay = new Date("2026-06-13T00:00:00.000Z"); // an "on" day from the anchor
    const offDay = new Date("2026-06-16T00:00:00.000Z"); // an "off" day from the anchor
    const hiddenOnDay = new Date("2026-06-02T00:00:00.000Z"); // "on", but before the start date

    expect(slotTimes(withoutStartDate, onDay)).toEqual(["09:00"]);
    expect(slotTimes(withStartDate, onDay)).toEqual(["09:00"]);

    expect(slotTimes(withoutStartDate, offDay)).toEqual([]);
    expect(slotTimes(withStartDate, offDay)).toEqual([]);

    expect(slotTimes(withoutStartDate, hiddenOnDay)).toEqual(["09:00"]);
    expect(slotTimes(withStartDate, hiddenOnDay)).toEqual([]);
  });
});
