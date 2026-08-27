import { HttpError } from "@moss/module-sdk";
import { MEDICATION_FREQUENCY_TYPES, type MedicationFrequencyTypeApi } from "@moss/shared";

import type {
  CreateMedicationInput,
  MedicationScheduleInput,
  UpdateMedicationInput
} from "./repository.js";
import {
  optionalNullableString,
  parseStringArray,
  requireObject,
  requiredString
} from "./parse-helpers.js";

/**
 * Everything that turns a raw medication request body into a validated input. Split out of
 * routes.ts when #1968 pushed that file past the 1000-line limit; the rules themselves are
 * unchanged by the move. Create and update share `parseMedicationScheduleBody`, which is what
 * makes editing a saved schedule safe: an edit is held to exactly the same rules as a create.
 */

/**
 * Validate the WHEN half of a medication request: the frequency type and every field that type
 * needs. Shared by create and update (#1968) so an edit is held to exactly the same rules as a
 * create — that shared validation is what made schedule editing safe to allow at all.
 *
 * Range-validates the numeric discriminator fields here so an out-of-range value surfaces as a
 * friendly 400 rather than tripping the DB CHECK as a 500 (matching the DB bounds:
 * times_per_day/interval_hours 1-24, cycle_days_on >= 1, cycle_days_off >= 0).
 */
function parseMedicationScheduleBody(value: Record<string, unknown>): MedicationScheduleInput {
  const frequencyType = value["frequencyType"];
  if (!isFrequencyType(frequencyType)) {
    throw new HttpError(
      400,
      `frequencyType must be one of ${MEDICATION_FREQUENCY_TYPES.join(", ")}`
    );
  }
  assertIntInRange(value["timesPerDay"], "timesPerDay", 1, 24);
  assertIntInRange(value["intervalHours"], "intervalHours", 1, 24);
  assertIntInRange(value["cycleDaysOn"], "cycleDaysOn", 1, 366);
  assertIntInRange(value["cycleDaysOff"], "cycleDaysOff", 0, 366);
  if (frequencyType === "times_per_day" && value["timesPerDay"] == null) {
    throw new HttpError(400, "timesPerDay is required for times_per_day");
  }
  if (frequencyType === "every_n_hours" && value["intervalHours"] == null) {
    throw new HttpError(400, "intervalHours is required for every_n_hours");
  }
  if (frequencyType === "specific_weekdays") {
    if (!isNonEmptyArray(value["weekdays"])) {
      throw new HttpError(400, "weekdays is required for specific_weekdays");
    }
    assertIsoWeekdays(value["weekdays"]);
  }
  // Scheduled families must carry at least one clock time (matches the DB CHECK).
  const scheduledFamilies = ["once_daily", "times_per_day", "specific_weekdays", "cyclical"];
  if (scheduledFamilies.includes(frequencyType) && !isNonEmptyArray(value["scheduleTimes"])) {
    throw new HttpError(400, `scheduleTimes is required for ${frequencyType}`);
  }
  // times_per_day must enumerate exactly that many clock times (matches the DB CHECK).
  if (
    frequencyType === "times_per_day" &&
    isNonEmptyArray(value["scheduleTimes"]) &&
    (value["scheduleTimes"] as unknown[]).length !== value["timesPerDay"]
  ) {
    throw new HttpError(400, "scheduleTimes length must equal timesPerDay");
  }
  if (
    frequencyType === "cyclical" &&
    (value["cycleAnchorDate"] == null || value["cycleDaysOn"] == null)
  ) {
    throw new HttpError(400, "cycleAnchorDate and cycleDaysOn are required for cyclical");
  }
  assertIntInRange(value["intervalCount"], "intervalCount", 1, 999);
  assertIntInRange(value["monthDay"], "monthDay", 1, 31);
  assertIntInRange(value["monthWeekday"], "monthWeekday", 1, 7);
  if (frequencyType === "every_interval") {
    const intervalUnit = value["intervalUnit"];
    if (intervalUnit !== "days" && intervalUnit !== "weeks" && intervalUnit !== "months") {
      throw new HttpError(400, "intervalUnit must be one of days, weeks, months");
    }
    if (value["intervalCount"] == null) {
      throw new HttpError(400, "intervalCount is required for every_interval");
    }
    if (!isNonEmptyArray(value["scheduleTimes"])) {
      throw new HttpError(400, "scheduleTimes is required for every_interval");
    }
    if (intervalUnit === "weeks") {
      if (!isNonEmptyArray(value["weekdays"])) {
        throw new HttpError(400, "weekdays is required for every_interval with weeks unit");
      }
      assertIsoWeekdays(value["weekdays"]);
    }
  }
  if (frequencyType === "monthly") {
    const monthKind = value["monthKind"];
    if (monthKind !== "date" && monthKind !== "weekdayPosition") {
      throw new HttpError(400, "monthKind must be one of date, weekdayPosition");
    }
    if (monthKind === "date") {
      const hasDay = value["monthDay"] != null;
      const isLast = value["monthDayIsLast"] === true;
      if (hasDay === isLast) {
        throw new HttpError(
          400,
          "exactly one of monthDay or monthDayIsLast is required for monthly by date"
        );
      }
    }
    if (monthKind === "weekdayPosition") {
      const position = value["monthWeekdayPosition"];
      const validPositions = ["first", "second", "third", "fourth", "last"];
      if (typeof position !== "string" || !validPositions.includes(position)) {
        throw new HttpError(
          400,
          "monthWeekdayPosition must be one of first, second, third, fourth, last"
        );
      }
      if (value["monthWeekday"] == null) {
        throw new HttpError(400, "monthWeekday is required for monthly by weekdayPosition");
      }
    }
    if (!isNonEmptyArray(value["scheduleTimes"])) {
      throw new HttpError(400, "scheduleTimes is required for monthly");
    }
  }
  // Start and end dates are available to EVERY schedule type (#1968). They stay REQUIRED for the
  // two types that count their repeat from the start date; for the rest they are optional
  // context ("I started this on the 3rd"), and the schedule engine simply produces no dose
  // before the start date or after the end date.
  assertDateKey(value["startDate"], "startDate");
  assertDateKey(value["endDate"], "endDate");
  assertDateKey(value["cycleAnchorDate"], "cycleAnchorDate");
  if (frequencyType === "every_interval" || frequencyType === "monthly") {
    if (typeof value["startDate"] !== "string" || !value["startDate"].trim()) {
      throw new HttpError(400, `startDate is required for ${frequencyType}`);
    }
  }
  if (
    typeof value["endDate"] === "string" &&
    typeof value["startDate"] === "string" &&
    value["endDate"] < value["startDate"]
  ) {
    throw new HttpError(400, "endDate must not be before startDate");
  }
  // as_needed (PRN) is unscheduled — reject the scheduling/cycle fields (matches the DB CHECK).
  // startDate and endDate are deliberately NOT on this list: an as-needed medication can still
  // record when the user started and stopped taking it.
  if (frequencyType === "as_needed") {
    for (const f of [
      "scheduleTimes",
      "timesPerDay",
      "intervalHours",
      "weekdays",
      "cycleAnchorDate",
      "cycleDaysOn",
      "cycleDaysOff",
      "intervalUnit",
      "intervalCount",
      "monthKind",
      "monthDay",
      "monthDayIsLast",
      "monthWeekdayPosition",
      "monthWeekday"
    ]) {
      if (value[f] != null && value[f] !== false) {
        throw new HttpError(400, `${f} is not allowed for as_needed`);
      }
    }
  }
  return {
    frequencyType,
    timesPerDay: optionalNumber(value["timesPerDay"]),
    intervalHours: optionalNumber(value["intervalHours"]),
    weekdays: optionalNumberArray(value["weekdays"]),
    scheduleTimes: optionalStringArrayOrNull(value["scheduleTimes"], "scheduleTimes"),
    cycleDaysOn: optionalNumber(value["cycleDaysOn"]),
    cycleDaysOff: optionalNumber(value["cycleDaysOff"]),
    cycleAnchorDate: optionalNullableString(value["cycleAnchorDate"], "cycleAnchorDate"),
    intervalUnit: value["intervalUnit"] as "days" | "weeks" | "months" | null | undefined,
    intervalCount: optionalNumber(value["intervalCount"]),
    startDate: optionalNullableString(value["startDate"], "startDate"),
    endDate: optionalNullableString(value["endDate"], "endDate"),
    monthKind: value["monthKind"] as "date" | "weekdayPosition" | null | undefined,
    monthDay: optionalNumber(value["monthDay"]),
    monthDayIsLast: value["monthDayIsLast"] as boolean | undefined,
    monthWeekdayPosition: value["monthWeekdayPosition"] as
      | "first"
      | "second"
      | "third"
      | "fourth"
      | "last"
      | null
      | undefined,
    monthWeekday: optionalNumber(value["monthWeekday"])
  };
}

/** ISO weekday integers, 1 (Mon) to 7 (Sun) — the DB enforces the same range. */
function assertIsoWeekdays(value: unknown): void {
  if ((value as number[]).some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new HttpError(400, "weekdays must be ISO weekday integers 1 (Mon) to 7 (Sun)");
  }
}

/**
 * A calendar date the caller sent, as YYYY-MM-DD. Checked here so a malformed value is a 400
 * instead of reaching Postgres and coming back as a 500. Absent or null is fine; the per-type
 * rules decide whether the field was required.
 */
function assertDateKey(value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${field} must be a date in YYYY-MM-DD form`);
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    throw new HttpError(400, `${field} must be a real calendar date`);
  }
}

/** Reminder on/off. A PRN medication has no scheduled time, so nothing could fire. */
function parseRemindersEnabled(
  value: unknown,
  frequencyType: MedicationFrequencyTypeApi | null
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "remindersEnabled must be a boolean");
  }
  if (value && frequencyType === "as_needed") {
    throw new HttpError(400, "remindersEnabled is not allowed for as_needed");
  }
  return value;
}

export function parseCreateMedicationBody(body: unknown): CreateMedicationInput {
  const value = requireObject(body);
  const name = requiredString(value["name"], "name");
  const schedule = parseMedicationScheduleBody(value);
  return {
    ...schedule,
    name,
    dosage: optionalNullableString(value["dosage"], "dosage"),
    form: optionalNullableString(value["form"], "form"),
    notes: optionalNullableString(value["notes"], "notes"),
    remindersEnabled: parseRemindersEnabled(value["remindersEnabled"], schedule.frequencyType)
  };
}

/** Every field that describes a schedule. Any one of them requires a frequencyType alongside. */
const MEDICATION_SCHEDULE_FIELDS = [
  "timesPerDay",
  "intervalHours",
  "weekdays",
  "scheduleTimes",
  "cycleDaysOn",
  "cycleDaysOff",
  "cycleAnchorDate",
  "intervalUnit",
  "intervalCount",
  "startDate",
  "endDate",
  "monthKind",
  "monthDay",
  "monthDayIsLast",
  "monthWeekdayPosition",
  "monthWeekday"
] as const;

/**
 * Parse an update. Changing the schedule is ALL-OR-NOTHING (#1968): send frequencyType together
 * with every field that type needs, and it is validated exactly like a create. A request with a
 * schedule field but no frequencyType is rejected, because a half-changed schedule would leave a
 * column from the previous type in place and trip a DB CHECK as a 500.
 */
export function parseUpdateMedicationBody(body: unknown): UpdateMedicationInput {
  const value = requireObject(body);
  const active = value["active"];
  if (active !== undefined && typeof active !== "boolean") {
    throw new HttpError(400, "active must be a boolean");
  }
  const changesSchedule = value["frequencyType"] !== undefined;
  if (!changesSchedule) {
    const stray = MEDICATION_SCHEDULE_FIELDS.find((field) => value[field] !== undefined);
    if (stray) {
      throw new HttpError(400, `frequencyType is required when changing ${stray}`);
    }
  }
  const schedule = changesSchedule ? parseMedicationScheduleBody(value) : undefined;
  return {
    name: value["name"] === undefined ? undefined : requiredString(value["name"], "name"),
    dosage: optionalNullableString(value["dosage"], "dosage"),
    form: optionalNullableString(value["form"], "form"),
    active: active as boolean | undefined,
    notes: optionalNullableString(value["notes"], "notes"),
    remindersEnabled: parseRemindersEnabled(
      value["remindersEnabled"],
      schedule?.frequencyType ?? null
    ),
    schedule
  };
}

function isFrequencyType(value: unknown): value is MedicationFrequencyTypeApi {
  return (
    typeof value === "string" && (MEDICATION_FREQUENCY_TYPES as readonly string[]).includes(value)
  );
}
function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number") throw new HttpError(400, "expected a number");
  return value;
}
function optionalNumberArray(value: unknown): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((n) => typeof n !== "number")) {
    throw new HttpError(400, "expected an array of numbers");
  }
  return value as number[];
}
function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
function assertIntInRange(value: unknown, field: string, min: number, max: number): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(
      400,
      `${field} must be an integer from ${min.toString()} to ${max.toString()}`
    );
  }
}
function optionalStringArrayOrNull(value: unknown, field: string): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseStringArray(value, field);
}
