import type { Medication, MedicationLog, WellnessCheckin, WellnessTherapyNote } from "@moss/db";
import type { CheckinDto, MedicationDto, MedicationLogDto, TherapyNoteDto } from "@moss/shared";

import { dateKeyFromColumn } from "./schedule.js";

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function serializeCheckin(row: WellnessCheckin): CheckinDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    checkedInAt: toIso(row.checked_in_at),
    feelingCore: row.feeling_core,
    feelingSecondary: row.feeling_secondary,
    feelingTertiary: row.feeling_tertiary,
    wheelVersion: row.wheel_version,
    sensations: row.sensations,
    intensity: row.intensity,
    energy: row.energy,
    note: row.note,
    identifiedVia: row.identified_via,
    createdAt: toIso(row.created_at)
  };
}

export function serializeMedication(row: Medication): MedicationDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    dosage: row.dosage,
    form: row.form,
    frequencyType: row.frequency_type,
    timesPerDay: row.times_per_day,
    intervalHours: row.interval_hours,
    weekdays: row.weekdays,
    scheduleTimes: row.schedule_times,
    cycleDaysOn: row.cycle_days_on,
    cycleDaysOff: row.cycle_days_off,
    cycleAnchorDate: row.cycle_anchor_date,
    active: row.active,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    scheduleStartDate: row.schedule_start_date ? dateKeyFromColumn(row.schedule_start_date) : null,
    scheduleEndDate: row.schedule_end_date ? dateKeyFromColumn(row.schedule_end_date) : null,
    timeZone: row.time_zone,
    intervalUnit: row.interval_unit,
    intervalCount: row.interval_count,
    monthKind: row.month_kind,
    monthDay: row.month_day,
    monthDayIsLast: row.month_day_is_last,
    monthWeekdayPosition: row.month_weekday_position,
    monthWeekday: row.month_weekday
  };
}

export function serializeMedicationLog(row: MedicationLog): MedicationLogDto {
  return {
    id: row.id,
    medicationId: row.medication_id,
    status: row.status,
    dose: row.dose,
    prnReason: row.prn_reason,
    scheduledFor: toIso(row.scheduled_for),
    loggedAt: toIso(row.logged_at)
  };
}

export function serializeTherapyNote(row: WellnessTherapyNote): TherapyNoteDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    body: row.body,
    linkedCheckinId: row.linked_checkin_id,
    linkedEmotion: row.linked_emotion,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}
