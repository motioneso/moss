import { describe, expect, it } from "vitest";
import type { MedicationLog } from "@moss/db";
import { computeSchedule } from "@moss/wellness";
import type { Medication } from "@moss/db";
import { medicationLogBelongsToDate } from "../../packages/wellness/src/repository.js";

// Regression pin for issue #877 finding 6 (wellness medication day-window).
//
// medicationLogBelongsToDate/medicationLogDayWindow anchors two different ways depending on
// whether the log is SCHEDULED or PRN:
//   - SCHEDULED (scheduled_for set): compared against a window keyed by the UTC calendar day of
//     `date` (medicationLogDayWindow's `dateKey = localDay(date, "UTC")`), independent of the
//     caller's timeZone. This is deliberate — scheduled_for is itself a date-keyed slot instant
//     (always stored at UTC midnight of its slot day), so the window must be UTC-keyed to match.
//   - PRN (scheduled_for null): compared against `logged_at` using a window converted from that
//     SAME dateKey into the actor's local timezone (`localDateTimeToUtc(dateKey, timeZone)`), so
//     an evening entry in the user's local zone still belongs to their local calendar day even
//     when UTC has already rolled to the next day.
//
// Both cases below pin CURRENT behavior, not a fix — see plan
// docs/superpowers/plans/2026-07-08-timezone-audit-fixes.md Task D step 3: if the PRN case had
// come back false (ambient-UTC bug, matching finding 6's pattern) the instruction was to pin and
// report rather than change repository.ts, since the window design may be deliberate. It returns
// true, confirming the PRN path already routes through the actor's timezone correctly.

function medicationLog(overrides: Partial<MedicationLog>): MedicationLog {
  return {
    id: "log-1",
    medication_id: "med-1",
    owner_user_id: "user-1",
    status: "taken",
    dose: null,
    prn_reason: null,
    scheduled_for: null,
    logged_at: new Date("2026-07-08T12:00:00.000Z"),
    created_at: new Date("2026-07-08T12:00:00.000Z"),
    ...overrides
  } as MedicationLog;
}

describe("medicationLogBelongsToDate — #877 finding 6 day-window pin", () => {
  it("PRN log: an evening-PT logged_at belongs to the PT-local day it was logged in, not the UTC day", () => {
    // 2026-07-09T04:00:00Z = 9 PM PDT on 2026-07-08 (America/Los_Angeles, UTC-7 in July).
    // `date` is passed the way routes.ts/export-job.ts construct it: UTC midnight of the
    // day-key string (`new Date(\`${dateKey}T00:00:00.000Z\`)`).
    const log = medicationLog({
      scheduled_for: null,
      logged_at: new Date("2026-07-09T04:00:00.000Z")
    });
    const date = new Date("2026-07-08T00:00:00.000Z");

    expect(medicationLogBelongsToDate(log, date, "America/Los_Angeles")).toBe(true);
  });

  it("PRN log: the same instant does NOT belong to the UTC calendar day (7/9) window", () => {
    const log = medicationLog({
      scheduled_for: null,
      logged_at: new Date("2026-07-09T04:00:00.000Z")
    });
    const date = new Date("2026-07-09T00:00:00.000Z");

    expect(medicationLogBelongsToDate(log, date, "America/Los_Angeles")).toBe(false);
  });

  it("SCHEDULED log: a date-keyed scheduled_for matches its UTC-keyed window regardless of timeZone", () => {
    // scheduled_for is itself a UTC-midnight slot instant for its day, so the match is
    // UTC-keyed — passing a non-UTC timeZone must not shift which day it belongs to.
    const log = medicationLog({
      scheduled_for: new Date("2026-07-08T00:00:00.000Z"),
      logged_at: new Date("2026-07-08T00:05:00.000Z")
    });
    const date = new Date("2026-07-08T00:00:00.000Z");

    expect(medicationLogBelongsToDate(log, date, "America/Los_Angeles")).toBe(true);
    expect(medicationLogBelongsToDate(log, date, "UTC")).toBe(true);
  });
});

// #3217: a zoned evening dose sits on the next UTC day, so every per-day reader must still
// pair its log with the slot on the local date.
describe("medicationLogBelongsToDate - zoned evening dose", () => {
  const monthlyLa = {
    id: "med-1",
    owner_user_id: "user-1",
    name: "Evening med",
    frequency_type: "monthly",
    month_kind: "date",
    month_day: 9,
    month_day_is_last: false,
    schedule_times: ["21:00"],
    schedule_start_date: "2026-01-01",
    time_zone: "America/Los_Angeles",
    active: true,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z")
  } as unknown as Medication;

  it("the taken log for a 21:00 Los Angeles dose shows the slot as taken on its local day", () => {
    const log = medicationLog({
      scheduled_for: new Date("2026-10-10T04:00:00.000Z"),
      logged_at: new Date("2026-10-10T04:05:00.000Z")
    });
    const day = new Date("2026-10-09T00:00:00.000Z");
    const dayLogs = [log].filter((l) => medicationLogBelongsToDate(l, day, "America/Los_Angeles"));
    const slots = computeSchedule([monthlyLa], dayLogs, day);
    expect(slots.map((s) => s.status)).toEqual(["taken"]);
  });
});
