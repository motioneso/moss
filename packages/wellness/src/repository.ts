import { sql } from "kysely";

import {
  assertDataContextDb,
  type DataContextDb,
  type Medication,
  type MedicationLog,
  type WellnessCheckin,
  type WellnessTherapyNote
} from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type {
  MedicationFrequencyTypeApi,
  MedicationLogStatusApi,
  WellnessEmotionCore as WellnessFeelingCore
} from "@moss/shared";
import { isValidFeelingPath, localDay } from "@moss/shared";

export interface CreateCheckinInput {
  readonly feelingCore: WellnessFeelingCore;
  readonly feelingSecondary?: string | null;
  readonly feelingTertiary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
  readonly identifiedVia?: "wheel" | "assisted";
}

export interface ListCheckinsOptions {
  readonly since?: Date;
  readonly limit?: number;
}

export interface CreateMedicationInput {
  readonly name: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay?: number | null;
  readonly intervalHours?: number | null;
  readonly weekdays?: readonly number[] | null;
  readonly scheduleTimes?: readonly string[] | null;
  readonly cycleDaysOn?: number | null;
  readonly cycleDaysOff?: number | null;
  readonly cycleAnchorDate?: string | null;
  readonly notes?: string | null;
  readonly intervalUnit?: "days" | "weeks" | "months" | null;
  readonly intervalCount?: number | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly monthKind?: "date" | "weekdayPosition" | null;
  readonly monthDay?: number | null;
  readonly monthDayIsLast?: boolean | null;
  readonly monthWeekdayPosition?: "first" | "second" | "third" | "fourth" | "last" | null;
  readonly monthWeekday?: number | null;
}

export interface UpdateMedicationInput {
  readonly name?: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly active?: boolean;
  readonly notes?: string | null;
}

export interface LogDoseInput {
  readonly status: MedicationLogStatusApi;
  readonly dose?: string | null;
  readonly prnReason?: string | null;
  readonly scheduledFor?: string | null;
}

export interface UpdateCheckinInput {
  readonly feelingCore: WellnessFeelingCore;
  readonly feelingSecondary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
}

export interface CreateTherapyNoteInput {
  readonly body: string;
  readonly linkedCheckinId?: string | null;
  readonly linkedEmotion?: WellnessFeelingCore | null;
}

export class WellnessRepository {
  // ── Check-ins ──────────────────────────────────────────────────────────
  async createCheckin(
    scopedDb: DataContextDb,
    input: CreateCheckinInput,
    timeZone = "UTC"
  ): Promise<WellnessCheckin> {
    assertDataContextDb(scopedDb);
    // #326/#771: derive the caller's calendar day + offset at check-in time from the
    // resolved request timezone (never UTC-only), so day-boundary attribution (weekday
    // insights, streaks) reflects the user's actual local day, not the server's UTC day.
    const now = new Date();
    const localDate = localDay(now, timeZone);
    const timezoneOffsetMinutes = Math.round(timeZoneOffsetMs(now, timeZone) / 60_000);
    const row = await scopedDb.db
      .insertInto("app.wellness_checkins")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        feeling_core: input.feelingCore,
        feeling_secondary: input.feelingSecondary ?? null,
        feeling_tertiary: null,
        sensations: [...(input.sensations ?? [])],
        intensity: input.intensity ?? null,
        energy: input.energy ?? null,
        note: input.note ?? null,
        identified_via: input.identifiedVia ?? "wheel",
        local_date: localDate,
        timezone_offset: timezoneOffsetMinutes
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as WellnessCheckin;
  }

  async listCheckins(
    scopedDb: DataContextDb,
    options: ListCheckinsOptions = {}
  ): Promise<WellnessCheckin[]> {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.wellness_checkins")
      .selectAll()
      .orderBy("checked_in_at", "desc");
    if (options.since) query = query.where("checked_in_at", ">=", options.since);
    query = query.limit(options.limit ?? 50);
    const rows = await query.execute();
    return rows as WellnessCheckin[];
  }

  // ── Medications ────────────────────────────────────────────────────────
  async createMedication(
    scopedDb: DataContextDb,
    input: CreateMedicationInput,
    timeZone: string
  ): Promise<Medication> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.medications")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        name: input.name,
        dosage: input.dosage ?? null,
        form: input.form ?? null,
        frequency_type: input.frequencyType,
        times_per_day: input.timesPerDay ?? null,
        interval_hours: input.intervalHours ?? null,
        weekdays: input.weekdays ? [...input.weekdays] : null,
        schedule_times: input.scheduleTimes ? [...input.scheduleTimes] : null,
        cycle_days_on: input.cycleDaysOn ?? null,
        cycle_days_off: input.cycleDaysOff ?? null,
        cycle_anchor_date: input.cycleAnchorDate ?? null,
        notes: input.notes ?? null,
        schedule_start_date: input.startDate ?? null,
        schedule_end_date: input.endDate ?? null,
        time_zone: timeZone,
        interval_unit: input.intervalUnit ?? null,
        interval_count: input.intervalCount ?? null,
        month_kind: input.monthKind ?? null,
        month_day: input.monthDay ?? null,
        month_day_is_last: input.monthDayIsLast ?? false,
        month_weekday_position: input.monthWeekdayPosition ?? null,
        month_weekday: input.monthWeekday ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as Medication;
  }

  async listMedications(scopedDb: DataContextDb): Promise<Medication[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.medications")
      .selectAll()
      .orderBy("active", "desc")
      .orderBy("name", "asc")
      .execute();
    return rows as Medication[];
  }

  async getMedication(scopedDb: DataContextDb, id: string): Promise<Medication | undefined> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.medications")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row as Medication | undefined;
  }

  async updateMedication(
    scopedDb: DataContextDb,
    id: string,
    input: UpdateMedicationInput
  ): Promise<Medication | undefined> {
    assertDataContextDb(scopedDb);
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) updates["name"] = input.name;
    if (input.dosage !== undefined) updates["dosage"] = input.dosage;
    if (input.form !== undefined) updates["form"] = input.form;
    if (input.active !== undefined) updates["active"] = input.active;
    if (input.notes !== undefined) updates["notes"] = input.notes;
    // schedule_times is NOT updatable in this slice (would need full discriminator re-validation).
    const row = await scopedDb.db
      .updateTable("app.medications")
      .set(updates)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as Medication | undefined;
  }

  // ── Dose logs ──────────────────────────────────────────────────────────
  /**
   * Log a dose. SCHEDULED (non-PRN) logs UPSERT on the (medication_id, scheduled_for) partial
   * unique index, so re-logging the same slot CORRECTS the record (e.g. fat-fingered "skipped"
   * → "taken") instead of being permanently rejected by the unique index — the slot's adherence
   * state stays editable. PRN logs (scheduled_for IS NULL) are not on the index and always insert.
   */
  async logDose(
    scopedDb: DataContextDb,
    medicationId: string,
    input: LogDoseInput
  ): Promise<MedicationLog> {
    assertDataContextDb(scopedDb);
    const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
    const values = {
      medication_id: medicationId,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      status: input.status,
      dose: input.dose ?? null,
      prn_reason: input.prnReason ?? null,
      scheduled_for: scheduledFor
    };

    // PRN doses are unscheduled (no conflict target) — plain insert.
    if (scheduledFor === null) {
      const row = await scopedDb.db
        .insertInto("app.medication_logs")
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      return row as MedicationLog;
    }

    // Scheduled doses upsert on the partial unique index so a correction overwrites the prior
    // log for that slot rather than tripping the unique violation. The conflict target matches
    // the index predicate (scheduled_for IS NOT NULL).
    const row = await scopedDb.db
      .insertInto("app.medication_logs")
      .values(values)
      .onConflict((oc) =>
        oc
          .columns(["medication_id", "scheduled_for"])
          .where("scheduled_for", "is not", null)
          .doUpdateSet({
            status: input.status,
            dose: input.dose ?? null,
            prn_reason: input.prnReason ?? null,
            logged_at: sql<Date>`now()`
          })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as MedicationLog;
  }

  async listRecentLogs(
    scopedDb: DataContextDb,
    options: { readonly sinceDays?: number } = {}
  ): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const sinceDays = options.sinceDays ?? 7;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where("logged_at", ">=", since)
      .orderBy("logged_at", "desc")
      .execute();
    return rows as MedicationLog[];
  }

  /**
   * Logs that belong to `date`. SCHEDULED logs are filtered by `scheduled_for` (the slot
   * instant), NOT `logged_at` (Codex R2) — a dose logged late/early (e.g. just after midnight)
   * still matches its slot's civil day. PRN logs (scheduled_for IS NULL) are unscheduled, so
   * they are anchored by `logged_at` instead and included for the day; computeSchedule uses
   * them only to count the day's PRN doses (prnCount), never to fill a scheduled slot.
   */
  async listLogsForDate(
    scopedDb: DataContextDb,
    date: Date,
    timeZone = "UTC"
  ): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const { scheduledStart, scheduledEnd, localStart, localEnd } = medicationLogDayWindow(
      date,
      timeZone
    );
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("scheduled_for", ">=", scheduledStart),
            eb("scheduled_for", "<", scheduledEnd)
          ]),
          eb.and([
            eb("scheduled_for", "is", null),
            eb("logged_at", ">=", localStart),
            eb("logged_at", "<", localEnd)
          ])
        ])
      )
      .execute();
    return rows as MedicationLog[];
  }

  /**
   * Logs over a rolling window for insights/adherence computation.
   *
   * Bucketing rules:
   *   - SCHEDULED logs (scheduled_for IS NOT NULL): included when scheduled_for >= since.
   *     This mirrors listLogsForDate — the slot's civil moment, NOT when the user tapped "taken".
   *   - PRN logs (scheduled_for IS NULL): included when logged_at >= since.
   *     PRN doses are unscheduled by definition, so logged_at is the only anchor.
   */
  async listLogsRange(
    scopedDb: DataContextDb,
    options: { readonly sinceDays?: number } = {}
  ): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const sinceDays = options.sinceDays ?? 30;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([eb("scheduled_for", "is not", null), eb("scheduled_for", ">=", since)]),
          eb.and([eb("scheduled_for", "is", null), eb("logged_at", ">=", since)])
        ])
      )
      .orderBy("logged_at", "desc")
      .execute();
    return rows as MedicationLog[];
  }

  async updateCheckin(
    scopedDb: DataContextDb,
    id: string,
    input: UpdateCheckinInput
  ): Promise<WellnessCheckin | undefined> {
    assertDataContextDb(scopedDb);
    const existing = await scopedDb.db
      .selectFrom("app.wellness_checkins")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!existing) return undefined;

    // Validate the combined feeling path: patch value if provided, else the stored value.
    // Prevents a feelingCore change from leaving a stale feelingSecondary from the old core.
    const effectiveSecondary =
      input.feelingSecondary !== undefined
        ? input.feelingSecondary
        : (existing.feeling_secondary as string | null);
    if (!isValidFeelingPath(input.feelingCore, effectiveSecondary, null)) {
      throw new HttpError(
        400,
        `feelingSecondary '${effectiveSecondary}' is not valid under feelingCore '${input.feelingCore}'`
      );
    }

    const updates: Record<string, unknown> = {
      feeling_core: input.feelingCore,
      feeling_tertiary: null // taxonomy invariant: 2-level only
    };
    // Only include optional fields when explicitly provided; omitted ⇒ preserve existing value.
    if (input.feelingSecondary !== undefined) updates["feeling_secondary"] = input.feelingSecondary;
    if (input.sensations !== undefined) updates["sensations"] = [...input.sensations];
    if (input.intensity !== undefined) updates["intensity"] = input.intensity ?? null;
    if (input.energy !== undefined) updates["energy"] = input.energy ?? null;
    if (input.note !== undefined) updates["note"] = input.note ?? null;

    const row = await scopedDb.db
      .updateTable("app.wellness_checkins")
      .set(updates)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    return row as WellnessCheckin | undefined;
  }

  // ── Therapy notes ──────────────────────────────────────────────────────

  async createTherapyNote(
    scopedDb: DataContextDb,
    input: CreateTherapyNoteInput
  ): Promise<WellnessTherapyNote> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.wellness_therapy_notes")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        body: input.body,
        linked_checkin_id: input.linkedCheckinId ?? null,
        linked_emotion: input.linkedEmotion ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as WellnessTherapyNote;
  }

  async listTherapyNotes(scopedDb: DataContextDb): Promise<WellnessTherapyNote[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.wellness_therapy_notes")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows as WellnessTherapyNote[];
  }

  async deleteTherapyNote(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.wellness_therapy_notes")
      .where("id", "=", id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }

  // ── Insights data ──────────────────────────────────────────────────────

  async listRecentCheckinsForInsights(
    scopedDb: DataContextDb,
    sinceDays: number
  ): Promise<WellnessCheckin[]> {
    assertDataContextDb(scopedDb);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await scopedDb.db
      .selectFrom("app.wellness_checkins")
      .selectAll()
      .where("checked_in_at", ">=", since)
      .orderBy("checked_in_at", "asc")
      .execute();
    return rows as WellnessCheckin[];
  }

  // ── Selective export: range-filtered reads (#484) ───────────────────────
  //
  // These mirror the list* methods above but bound the query to an inclusive [from, to] window.
  // Used by the wellness-export worker so only records in the selected timeframe are rendered.
  // Anchor columns follow each kind's existing semantics: check-ins by checked_in_at, therapy
  // notes by created_at; logs reuse the scheduled_for OR logged_at pattern from listLogsRange
  // (scheduled doses anchored by their slot instant, PRN doses by when they were logged).

  async listCheckinsForRange(
    scopedDb: DataContextDb,
    from: Date,
    to: Date
  ): Promise<WellnessCheckin[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.wellness_checkins")
      .selectAll()
      .where("checked_in_at", ">=", from)
      .where("checked_in_at", "<=", to)
      .orderBy("checked_in_at", "asc")
      .execute();
    return rows as WellnessCheckin[];
  }

  async listLogsForRange(scopedDb: DataContextDb, from: Date, to: Date): Promise<MedicationLog[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.medication_logs")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("scheduled_for", "is not", null),
            eb("scheduled_for", ">=", from),
            eb("scheduled_for", "<=", to)
          ]),
          eb.and([
            eb("scheduled_for", "is", null),
            eb("logged_at", ">=", from),
            eb("logged_at", "<=", to)
          ])
        ])
      )
      .orderBy("logged_at", "asc")
      .execute();
    return rows as MedicationLog[];
  }

  async listTherapyNotesForRange(
    scopedDb: DataContextDb,
    from: Date,
    to: Date
  ): Promise<WellnessTherapyNote[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.wellness_therapy_notes")
      .selectAll()
      .where("created_at", ">=", from)
      .where("created_at", "<=", to)
      .orderBy("created_at", "asc")
      .execute();
    return rows as WellnessTherapyNote[];
  }
}

export function medicationLogBelongsToDate(
  log: MedicationLog,
  date: Date,
  timeZone = "UTC"
): boolean {
  const { scheduledStart, scheduledEnd, localStart, localEnd } = medicationLogDayWindow(
    date,
    timeZone
  );
  if (log.scheduled_for) {
    const scheduledFor =
      log.scheduled_for instanceof Date ? log.scheduled_for : new Date(log.scheduled_for);
    return scheduledFor >= scheduledStart && scheduledFor < scheduledEnd;
  }
  const loggedAt = log.logged_at instanceof Date ? log.logged_at : new Date(log.logged_at);
  return loggedAt >= localStart && loggedAt < localEnd;
}

function medicationLogDayWindow(
  date: Date,
  timeZone: string
): {
  scheduledStart: Date;
  scheduledEnd: Date;
  localStart: Date;
  localEnd: Date;
} {
  const dateKey = localDay(date, "UTC");
  const nextKey = addDays(dateKey, 1);
  return {
    scheduledStart: new Date(`${dateKey}T00:00:00.000Z`),
    scheduledEnd: new Date(`${nextKey}T00:00:00.000Z`),
    localStart: localDateTimeToUtc(dateKey, timeZone),
    localEnd: localDateTimeToUtc(nextKey, timeZone)
  };
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return localDay(new Date(Date.UTC(year!, month! - 1, day! + days)), "UTC");
}

function localDateTimeToUtc(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const localAsUtc = new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0));
  const offset = timeZoneOffsetMs(localAsUtc, timeZone);
  const first = new Date(localAsUtc.getTime() - offset);
  const correctedOffset = timeZoneOffsetMs(first, timeZone);
  return new Date(localAsUtc.getTime() - correctedOffset);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second"))
  );
  return localAsUtc - date.getTime();
}
