import type { Medication, MedicationLog } from "@moss/db";
import type { ScheduleSlotDto } from "@moss/shared";

import {
  expandOccurrences,
  type MedicationSchedule,
  type ScheduleAnchor,
  type Weekday,
  type WeekdayPosition
} from "./occurrence-engine.js";

/**
 * Pure: given the actor's medications, their same-day dose logs, and a target date,
 * produce an ordered list of schedule slots. Scheduled (non-PRN) meds emit one slot per
 * schedule_time that applies on `date`; as_needed meds emit a single asNeeded affordance.
 * A slot is "taken"/"skipped" if a same-day log has a matching scheduled_for (same clock
 * minute) for that medication, else "pending".
 *
 * Timezone model (deliberate, documented — Codex R1): this uses NAIVE CIVIL time. The
 * caller (web) sends its OWN LOCAL civil date (`YYYY-MM-DD`) as `?date=`; the server parses
 * it as a UTC midnight anchor and builds each slot by attaching the med's civil clock time
 * (`schedule_times`, a `time[]`) to that anchor IN UTC. Dose instants are produced by the
 * shared occurrence engine (#1950) with `timeZone: "UTC"`, which reproduces this same
 * civil-as-UTC arithmetic exactly (a UTC anchor has no daylight-saving transitions). Because
 * both the slot instant and the matched log's `scheduled_for` are constructed the same way,
 * the minute-level match is correct, and the displayed `HH:MM` (via `.slice(11,16)`) shows
 * the civil clock time the user entered. The only requirement is that the client sends its
 * LOCAL date (not a UTC date) so a near-midnight check lands on the right civil day. True
 * per-user-timezone scheduling (DST-aware absolute instants) is explicitly out of scope.
 */
export function computeSchedule(
  medications: readonly Medication[],
  logs: readonly MedicationLog[],
  date: Date
): ScheduleSlotDto[] {
  const slots: ScheduleSlotDto[] = [];
  const dayRange = { from: date, to: new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1) };

  const requestedDay = date.toISOString().slice(0, 10);

  for (const med of medications) {
    if (!med.active) continue;
    if (!isWithinScheduleWindow(med, requestedDay)) continue;

    if (med.frequency_type === "as_needed") {
      slots.push({
        medicationId: med.id,
        name: med.name,
        scheduledFor: null,
        asNeeded: true,
        status: "pending",
        prnCount: countPrnLogs(med.id, logs)
      });
      continue;
    }

    const engineInput = toEngineInput(med);
    const occurrences = expandOccurrences(engineInput.schedule, engineInput.anchor, dayRange);

    for (const occurrence of occurrences) {
      slots.push({
        medicationId: med.id,
        name: med.name,
        scheduledFor: occurrence.at.toISOString(),
        asNeeded: false,
        status: slotStatusFromLogs(med.id, occurrence.at, logs)
      });
    }
  }

  return slots.sort((a, b) => {
    if (a.asNeeded !== b.asNeeded) return a.asNeeded ? 1 : -1;
    return (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "");
  });
}

/**
 * Is this medication's schedule running on the requested civil day? Every schedule type can now
 * carry a start date and an optional end date (#1968), so a medication produces no dose before it
 * starts or after it ends — including in the adherence counts, which would otherwise report
 * missed doses for days the user had not begun taking it.
 *
 * Deliberately a day-level window rather than feeding the start date into the occurrence engine's
 * anchor: for a cycle schedule the anchor is `cycle_anchor_date` and it decides which days are
 * "on" days, so substituting a different date would shift the whole on/off pattern. Clamping the
 * day leaves every family's repeat maths exactly as it was. Medications with neither date stored
 * behave exactly as before.
 */
export function isWithinScheduleWindow(med: Medication, dayKey: string): boolean {
  if (med.schedule_start_date && dayKey < dateKeyFromColumn(med.schedule_start_date)) return false;
  if (med.schedule_end_date && dayKey > dateKeyFromColumn(med.schedule_end_date)) return false;
  return true;
}

/** No schedule family here has a real "start date" concept of its own (unlike `cyclical`,
 *  which is always counted from `cycle_anchor_date`), and the old date math never gated on
 *  one either — so this is fixed far enough in the past to never filter out a real query day. */
const NO_START_DATE_GATING = "1970-01-01";

/**
 * Maps a medication row to the shared occurrence engine's schedule + anchor shape. Every
 * family uses `timeZone: "UTC"` to match this module's naive-civil-time model (see the
 * module doc comment above).
 */
function toEngineInput(med: Medication): { schedule: MedicationSchedule; anchor: ScheduleAnchor } {
  const doseTimes = med.schedule_times ?? [];
  const openAnchor: ScheduleAnchor = { startDate: NO_START_DATE_GATING, timeZone: "UTC" };

  if (med.frequency_type === "specific_weekdays") {
    return {
      schedule: { family: "selectedDays", weekdays: (med.weekdays ?? []) as Weekday[], doseTimes },
      anchor: openAnchor
    };
  }

  if (med.frequency_type === "every_n_hours") {
    return {
      schedule: {
        family: "daily",
        doseTimes: everyNHoursDoseTimes(med.interval_hours, doseTimes[0])
      },
      anchor: openAnchor
    };
  }

  if (med.frequency_type === "cyclical") {
    const cycleLength = (med.cycle_days_on ?? 0) + (med.cycle_days_off ?? 0);
    // A misconfigured cycle (no anchor, no on-days, or a non-positive length) falls back to
    // "always eligible" — matches the old isCyclicalOnDay's default.
    if (!med.cycle_anchor_date || !med.cycle_days_on || cycleLength <= 0) {
      return { schedule: { family: "daily", doseTimes }, anchor: openAnchor };
    }
    return {
      schedule: {
        family: "cycle",
        daysOn: med.cycle_days_on,
        daysOff: med.cycle_days_off ?? 0,
        doseTimes
      },
      anchor: { startDate: dateKeyFromColumn(med.cycle_anchor_date), timeZone: "UTC" }
    };
  }

  if (med.frequency_type === "every_interval") {
    const anchor: ScheduleAnchor = {
      startDate: dateKeyFromColumn(med.schedule_start_date!),
      endDate: med.schedule_end_date ? dateKeyFromColumn(med.schedule_end_date) : null,
      timeZone: med.time_zone ?? "UTC"
    };
    if (med.interval_unit === "weeks") {
      return {
        schedule: {
          family: "everyInterval",
          unit: "weeks",
          interval: med.interval_count!,
          weekdays: (med.weekdays ?? []) as Weekday[],
          doseTimes
        },
        anchor
      };
    }
    return {
      schedule: {
        family: "everyInterval",
        unit: med.interval_unit === "months" ? "months" : "days",
        interval: med.interval_count!,
        doseTimes
      },
      anchor
    };
  }

  if (med.frequency_type === "monthly") {
    const anchor: ScheduleAnchor = {
      startDate: dateKeyFromColumn(med.schedule_start_date!),
      endDate: med.schedule_end_date ? dateKeyFromColumn(med.schedule_end_date) : null,
      timeZone: med.time_zone ?? "UTC"
    };
    if (med.month_kind === "weekdayPosition") {
      return {
        schedule: {
          family: "monthly",
          kind: "weekdayPosition",
          position: med.month_weekday_position as WeekdayPosition,
          weekday: med.month_weekday as Weekday,
          doseTimes
        },
        anchor
      };
    }
    return {
      schedule: {
        family: "monthly",
        kind: "date",
        dayOfMonth: med.month_day_is_last ? "last" : (med.month_day as number),
        doseTimes
      },
      anchor
    };
  }

  // once_daily, times_per_day
  return { schedule: { family: "daily", doseTimes }, anchor: openAnchor };
}

/**
 * `cycle_anchor_date` is typed `string` (a Postgres `date` column) but the driver actually
 * hands back a JS `Date` at runtime, not a "YYYY-MM-DD" string — the old date math coerced it
 * through a template literal (silently wrong, but never threw); the engine's `startDate`
 * requires a real date-key string, so normalize explicitly here instead.
 */
export function dateKeyFromColumn(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

/**
 * The clock times an every-N-hours medication fires at in one civil day. This is the same
 * set every day (it only depends on the interval and the anchor time-of-day, never on the
 * date), so it can be precomputed once and handed to the engine as a fixed `daily` schedule
 * instead of extending the engine with an hours-based family.
 */
function everyNHoursDoseTimes(
  intervalHours: number | null,
  anchorTime: string | undefined
): string[] {
  if (!intervalHours || intervalHours <= 0) return [];
  const [hourStr, minuteStr] = (anchorTime ?? "00:00").split(":");
  const startMinutes = Number(hourStr ?? 0) * 60 + Number(minuteStr ?? 0);
  const stepMinutes = intervalHours * 60;

  const times: string[] = [];
  for (let t = startMinutes; t < 24 * 60; t += stepMinutes) {
    const hour = Math.floor(t / 60);
    const minute = t % 60;
    times.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return times;
}

/**
 * Count the PRN doses logged for a med on this date. PRN logs are the unscheduled
 * (scheduled_for IS NULL) rows with status "prn"; the caller passes same-day logs, so this is
 * the per-day count surfaced as the as_needed slot's prnCount.
 */
function countPrnLogs(medicationId: string, logs: readonly MedicationLog[]): number {
  let count = 0;
  for (const log of logs) {
    if (log.medication_id !== medicationId) continue;
    if (log.scheduled_for) continue;
    if (log.status === "prn") count++;
  }
  return count;
}

function slotStatusFromLogs(
  medicationId: string,
  scheduledFor: Date,
  logs: readonly MedicationLog[]
): "pending" | "taken" | "skipped" {
  const target = scheduledFor.getTime();
  for (const log of logs) {
    if (log.medication_id !== medicationId) continue;
    if (!log.scheduled_for) continue;
    const logged =
      log.scheduled_for instanceof Date ? log.scheduled_for : new Date(log.scheduled_for);
    if (Math.abs(logged.getTime() - target) < 60_000) {
      if (log.status === "taken") return "taken";
      if (log.status === "skipped") return "skipped";
    }
  }
  return "pending";
}
