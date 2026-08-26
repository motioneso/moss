import type { CreateMedicationRequest } from "@moss/shared";
import type { Medication } from "@moss/db";

/**
 * #1970 — the logic behind the add-a-medication form, kept out of the component so it can be
 * tested directly against the server's own validator.
 *
 * The person filling the form picks one of SIX things ("every day", "certain days of the week",
 * ...). The database stores EIGHT frequency values, two of which — `once_daily` and
 * `times_per_day` — are the same choice with a different number of clock times, and one of which
 * (`every_n_hours`) is a legacy type this form never creates. `buildCreateRequest` is where the
 * six become the eight; nothing above this file needs to know the stored names.
 *
 * The rules enforced here mirror packages/wellness/src/medication-request-parsing.ts exactly, so
 * the form can say what is missing in plain English before the request is sent rather than
 * surfacing a 400. The unit test runs every request this file builds through that same validator,
 * which is what keeps the two in step.
 */

export type ScheduleChoice =
  | "daily"
  | "selected_days"
  | "every_interval"
  | "monthly"
  | "cycle"
  | "as_needed";

export interface ScheduleChoiceOption {
  readonly value: ScheduleChoice;
  readonly label: string;
  readonly hint: string;
}

export const SCHEDULE_CHOICES: readonly ScheduleChoiceOption[] = [
  { value: "daily", label: "Every day", hint: "One or more times a day, every day." },
  {
    value: "selected_days",
    label: "Certain days",
    hint: "Only on the days of the week you pick."
  },
  {
    value: "every_interval",
    label: "Every so often",
    hint: "Every few days, weeks or months, counting from the start date."
  },
  { value: "monthly", label: "Monthly", hint: "Once a month, on a date or a weekday." },
  { value: "cycle", label: "In a cycle", hint: "So many days on, then so many days off." },
  {
    value: "as_needed",
    label: "Only when needed",
    hint: "No set times. Log a dose when you take it."
  }
];

export type IntervalUnit = "days" | "weeks" | "months";
export type MonthKind = "date" | "weekdayPosition";
export type MonthWeekdayPosition = "first" | "second" | "third" | "fourth" | "last";

export interface MedFormState {
  readonly name: string;
  readonly dose: string;
  readonly choice: ScheduleChoice;
  /** Clock times in "HH:MM". One entry per dose in the day. */
  readonly times: readonly string[];
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. */
  readonly weekdays: readonly number[];
  readonly intervalCount: number;
  readonly intervalUnit: IntervalUnit;
  readonly monthKind: MonthKind;
  readonly monthDay: number;
  readonly monthDayIsLast: boolean;
  readonly monthWeekdayPosition: MonthWeekdayPosition;
  readonly monthWeekday: number;
  readonly cycleDaysOn: number;
  readonly cycleDaysOff: number;
  /** "YYYY-MM-DD", or "" when the person has not set one. */
  readonly startDate: string;
  readonly remindersEnabled: boolean;
}

export const WEEKDAY_LABELS: readonly { value: number; short: string; long: string }[] = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" }
];

export const MONTH_POSITION_LABELS: readonly { value: MonthWeekdayPosition; label: string }[] = [
  { value: "first", label: "First" },
  { value: "second", label: "Second" },
  { value: "third", label: "Third" },
  { value: "fourth", label: "Fourth" },
  { value: "last", label: "Last" }
];

export const MAX_DOSES_PER_DAY = 6;

/** A brand-new form. `today` is the person's own local date, as "YYYY-MM-DD". */
export function emptyMedForm(today: string): MedFormState {
  return {
    name: "",
    dose: "",
    choice: "daily",
    times: ["08:00"],
    weekdays: [],
    intervalCount: 2,
    intervalUnit: "days",
    monthKind: "date",
    monthDay: 1,
    monthDayIsLast: false,
    monthWeekdayPosition: "first",
    monthWeekday: 1,
    cycleDaysOn: 21,
    cycleDaysOff: 7,
    startDate: today,
    remindersEnabled: false
  };
}

/**
 * Switch to a different schedule choice, REPLACING every schedule field with that choice's own
 * defaults rather than merging. A leftover value from the previous choice would be rejected by
 * the server (and, for some combinations, would trip a database check as a 500), so the form
 * never carries one across. Name, dose, start date and the reminder switch survive the switch,
 * because they mean the same thing whatever the schedule is.
 */
export function withChoice(
  state: MedFormState,
  choice: ScheduleChoice,
  today: string
): MedFormState {
  const fresh = emptyMedForm(today);
  return {
    ...fresh,
    name: state.name,
    dose: state.dose,
    startDate: state.startDate,
    remindersEnabled: supportsReminders(choice) ? state.remindersEnabled : false,
    choice,
    times: choice === "as_needed" ? [] : fresh.times
  };
}

/** These two count their repeat from the start date, so the server insists on one. */
export function startDateRequired(choice: ScheduleChoice): boolean {
  return choice === "every_interval" || choice === "monthly";
}

/** An as-needed medication has no scheduled time, so there is nothing to remind anyone about. */
export function supportsReminders(choice: ScheduleChoice): boolean {
  return choice !== "as_needed";
}

/** Whether this choice is taken at set clock times. */
export function usesClockTimes(choice: ScheduleChoice): boolean {
  return choice !== "as_needed";
}

/** Whether this choice needs the person to tick days of the week. */
export function usesWeekdays(state: Pick<MedFormState, "choice" | "intervalUnit">): boolean {
  if (state.choice === "selected_days") return true;
  return state.choice === "every_interval" && state.intervalUnit === "weeks";
}

export function isValidClockTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours <= 23 && minutes <= 59;
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Every reason this form cannot be saved yet, in the order the fields appear on screen, phrased
 * for the person filling it in. An empty list means the request will be accepted.
 */
export function describeFormProblems(state: MedFormState): string[] {
  const problems: string[] = [];

  if (!state.name.trim()) problems.push("Give the medication a name.");

  if (usesClockTimes(state.choice)) {
    if (state.times.length === 0) {
      problems.push("Add at least one time of day.");
    } else if (state.times.some((time) => !isValidClockTime(time))) {
      problems.push("Enter each time of day as a real clock time, like 08:00.");
    }
  }

  if (usesWeekdays(state)) {
    if (state.weekdays.length === 0) problems.push("Pick at least one day of the week.");
  }

  if (state.choice === "every_interval" && !Number.isInteger(state.intervalCount)) {
    problems.push("Say how often it repeats.");
  } else if (state.choice === "every_interval" && state.intervalCount < 1) {
    problems.push("It has to repeat at least every one day, week or month.");
  }

  if (state.choice === "monthly" && state.monthKind === "date" && !state.monthDayIsLast) {
    if (!Number.isInteger(state.monthDay) || state.monthDay < 1 || state.monthDay > 31) {
      problems.push("Pick a day of the month between 1 and 31.");
    }
  }

  if (state.choice === "cycle") {
    if (!Number.isInteger(state.cycleDaysOn) || state.cycleDaysOn < 1) {
      problems.push("A cycle needs at least one day on.");
    }
    if (!Number.isInteger(state.cycleDaysOff) || state.cycleDaysOff < 0) {
      problems.push("Days off cannot be a negative number.");
    }
  }

  if (state.startDate) {
    if (!isValidDateKey(state.startDate)) problems.push("Enter the start date as a real date.");
  } else if (startDateRequired(state.choice)) {
    problems.push("Pick the date this starts, so the repeat has something to count from.");
  }

  return problems;
}

/** The clock times to save: as-needed has none, and blank rows are dropped. */
function scheduleTimesFor(state: MedFormState): string[] {
  if (!usesClockTimes(state.choice)) return [];
  return state.times.filter((time) => time.trim().length > 0);
}

/**
 * The request that creates this medication. The six on-screen choices become the stored
 * frequency values here: "every day" is `once_daily` with a single clock time and
 * `times_per_day` with more than one, and the other four map one-to-one.
 */
export function buildCreateRequest(state: MedFormState): CreateMedicationRequest {
  const times = scheduleTimesFor(state);
  const startDate = state.startDate ? state.startDate : null;
  const base = {
    name: state.name.trim(),
    dosage: state.dose.trim() ? state.dose.trim() : null,
    startDate
  };

  switch (state.choice) {
    case "as_needed":
      // Every scheduling field is rejected outright for as-needed, including the reminder
      // switch; only the name, dose and start date go with it.
      return { ...base, frequencyType: "as_needed" };

    case "daily":
      return times.length > 1
        ? {
            ...base,
            frequencyType: "times_per_day",
            timesPerDay: times.length,
            scheduleTimes: times,
            remindersEnabled: state.remindersEnabled
          }
        : {
            ...base,
            frequencyType: "once_daily",
            scheduleTimes: times,
            remindersEnabled: state.remindersEnabled
          };

    case "selected_days":
      return {
        ...base,
        frequencyType: "specific_weekdays",
        weekdays: [...state.weekdays].sort((a, b) => a - b),
        scheduleTimes: times,
        remindersEnabled: state.remindersEnabled
      };

    case "every_interval":
      return {
        ...base,
        frequencyType: "every_interval",
        intervalUnit: state.intervalUnit,
        intervalCount: state.intervalCount,
        // Only the weeks unit pins the repeat to particular weekdays.
        weekdays: state.intervalUnit === "weeks" ? [...state.weekdays].sort((a, b) => a - b) : null,
        scheduleTimes: times,
        remindersEnabled: state.remindersEnabled
      };

    case "monthly":
      return {
        ...base,
        frequencyType: "monthly",
        monthKind: state.monthKind,
        monthDay: state.monthKind === "date" && !state.monthDayIsLast ? state.monthDay : null,
        monthDayIsLast: state.monthKind === "date" ? state.monthDayIsLast : false,
        monthWeekdayPosition:
          state.monthKind === "weekdayPosition" ? state.monthWeekdayPosition : null,
        monthWeekday: state.monthKind === "weekdayPosition" ? state.monthWeekday : null,
        scheduleTimes: times,
        remindersEnabled: state.remindersEnabled
      };

    case "cycle":
      return {
        ...base,
        frequencyType: "cyclical",
        cycleDaysOn: state.cycleDaysOn,
        cycleDaysOff: state.cycleDaysOff,
        // The cycle counts from the day the person starts taking it, so the anchor and the
        // start date are the same thing on this form rather than two dates to keep in step.
        cycleAnchorDate: startDate,
        scheduleTimes: times,
        remindersEnabled: state.remindersEnabled
      };
  }
}

/**
 * The form's values shaped as a saved medication row, so the shipped `describeSchedule` and
 * `nextDoses` can preview the schedule before anything is written. `timeZone` is the browser's
 * own zone, which is the same zone the server records when the medication is actually created
 * (packages/wellness/src/repository.ts). Nothing here is sent anywhere — it exists only to feed
 * the two preview functions.
 */
export function previewMedication(state: MedFormState, timeZone: string): Medication {
  const request = buildCreateRequest(state) as CreateMedicationRequest & Record<string, unknown>;
  const asNumberArray = (value: unknown): number[] | null =>
    Array.isArray(value) ? (value as number[]) : null;

  return {
    id: "preview",
    owner_user_id: "preview",
    name: request.name,
    dosage: request.dosage ?? null,
    form: null,
    frequency_type: request.frequencyType,
    times_per_day: (request.timesPerDay as number | undefined) ?? null,
    interval_hours: null,
    weekdays: asNumberArray(request["weekdays"]),
    schedule_times: (request.scheduleTimes as string[] | undefined) ?? null,
    cycle_days_on: (request.cycleDaysOn as number | undefined) ?? null,
    cycle_days_off: (request.cycleDaysOff as number | undefined) ?? null,
    cycle_anchor_date: (request.cycleAnchorDate as string | undefined) ?? null,
    active: true,
    notes: null,
    schedule_start_date: request.startDate ?? null,
    schedule_end_date: null,
    time_zone: timeZone,
    interval_unit: (request.intervalUnit as IntervalUnit | undefined) ?? null,
    interval_count: (request.intervalCount as number | undefined) ?? null,
    month_kind: (request.monthKind as MonthKind | undefined) ?? null,
    month_day: (request.monthDay as number | undefined) ?? null,
    month_day_is_last: request.monthDayIsLast === true,
    month_weekday_position:
      (request.monthWeekdayPosition as MonthWeekdayPosition | undefined) ?? null,
    month_weekday: (request.monthWeekday as number | undefined) ?? null,
    reminders_enabled: request.remindersEnabled === true,
    created_at: new Date(),
    updated_at: new Date()
  } as Medication;
}

/** The browser's own time zone, or UTC if it cannot be read. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Today's date in the browser's own zone, as "YYYY-MM-DD". */
export function todayDateKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: browserTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  return parts;
}
