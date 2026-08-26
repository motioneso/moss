// Wellness REST contract. Part of the Vite-bundled @moss/shared package — NO node:* imports.
import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";

export const WELLNESS_EMOTION_CORES = [
  "happy",
  "sad",
  "fear",
  "anger",
  "disgust",
  "surprise"
] as const;
export type WellnessEmotionCore = (typeof WELLNESS_EMOTION_CORES)[number];

export const MEDICATION_FREQUENCY_TYPES = [
  "once_daily",
  "times_per_day",
  "specific_weekdays",
  "every_n_hours",
  "as_needed",
  "cyclical",
  "every_interval",
  "monthly"
] as const;
export type MedicationFrequencyTypeApi = (typeof MEDICATION_FREQUENCY_TYPES)[number];

export const MEDICATION_LOG_STATUSES = ["taken", "skipped", "prn"] as const;
export type MedicationLogStatusApi = (typeof MEDICATION_LOG_STATUSES)[number];

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface CheckinDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly checkedInAt: string | null;
  readonly feelingCore: WellnessEmotionCore;
  readonly feelingSecondary: string | null;
  readonly feelingTertiary: string | null;
  readonly wheelVersion: string;
  readonly sensations: readonly string[];
  readonly intensity: number | null;
  readonly energy: number | null;
  readonly note: string | null;
  readonly identifiedVia: "wheel" | "assisted";
  readonly createdAt: string | null;
}

export interface CreateCheckinRequest {
  readonly feelingCore: WellnessEmotionCore;
  readonly feelingSecondary?: string | null;
  readonly feelingTertiary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
  readonly identifiedVia?: "wheel" | "assisted";
}

export interface CreateCheckinResponse {
  readonly checkin: CheckinDto;
}
export interface ListCheckinsResponse {
  readonly checkins: readonly CheckinDto[];
}

export interface UpdateCheckinRequest {
  readonly feelingCore: WellnessEmotionCore;
  readonly feelingSecondary?: string | null;
  readonly feelingTertiary?: string | null;
  readonly sensations?: readonly string[];
  readonly intensity?: number | null;
  readonly energy?: number | null;
  readonly note?: string | null;
}
export interface UpdateCheckinResponse {
  readonly checkin: CheckinDto;
}

export interface MedicationDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly dosage: string | null;
  readonly form: string | null;
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay: number | null;
  readonly intervalHours: number | null;
  readonly weekdays: readonly number[] | null;
  readonly scheduleTimes: readonly string[] | null;
  readonly cycleDaysOn: number | null;
  readonly cycleDaysOff: number | null;
  readonly cycleAnchorDate: string | null;
  readonly active: boolean;
  readonly notes: string | null;
  readonly scheduleStartDate: string | null;
  readonly scheduleEndDate: string | null;
  readonly timeZone: string | null;
  readonly intervalUnit: "days" | "weeks" | "months" | null;
  readonly intervalCount: number | null;
  readonly monthKind: "date" | "weekdayPosition" | null;
  readonly monthDay: number | null;
  readonly monthDayIsLast: boolean;
  readonly monthWeekdayPosition: "first" | "second" | "third" | "fourth" | "last" | null;
  readonly monthWeekday: number | null;
  readonly remindersEnabled: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface CreateMedicationRequest {
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
  readonly remindersEnabled?: boolean | null;
}

/**
 * The schedule half of a medication request. An update that changes the schedule sends this
 * whole object — `frequencyType` plus every field that type needs — and the server validates it
 * with exactly the same rules as a create (#1968). Partial schedule edits are rejected: a
 * leftover column from the previous frequency type would trip a DB CHECK as a 500.
 */
export interface MedicationScheduleRequestFields {
  readonly frequencyType: MedicationFrequencyTypeApi;
  readonly timesPerDay?: number | null;
  readonly intervalHours?: number | null;
  readonly weekdays?: readonly number[] | null;
  readonly scheduleTimes?: readonly string[] | null;
  readonly cycleDaysOn?: number | null;
  readonly cycleDaysOff?: number | null;
  readonly cycleAnchorDate?: string | null;
  readonly intervalUnit?: "days" | "weeks" | "months" | null;
  readonly intervalCount?: number | null;
  readonly startDate?: string | null;
  readonly endDate?: string | null;
  readonly monthKind?: "date" | "weekdayPosition" | null;
  readonly monthDay?: number | null;
  readonly monthDayIsLast?: boolean | null;
  readonly monthWeekdayPosition?: "first" | "second" | "third" | "fourth" | "last" | null;
  readonly monthWeekday?: number | null;
  readonly remindersEnabled?: boolean | null;
}

// An update may change the schedule (#1968). Doing so is all-or-nothing: send `frequencyType`
// together with every field that type needs, and the server re-validates the full discriminator
// before writing. Omit `frequencyType` entirely to leave the schedule alone.
export interface UpdateMedicationRequest extends Partial<MedicationScheduleRequestFields> {
  readonly name?: string;
  readonly dosage?: string | null;
  readonly form?: string | null;
  readonly active?: boolean;
  readonly notes?: string | null;
}

export interface MedicationResponse {
  readonly medication: MedicationDto;
}
export interface ListMedicationsResponse {
  readonly medications: readonly MedicationDto[];
}

export interface MedicationLogDto {
  readonly id: string;
  readonly medicationId: string;
  readonly status: MedicationLogStatusApi;
  readonly dose: string | null;
  readonly prnReason: string | null;
  readonly scheduledFor: string | null;
  readonly loggedAt: string | null;
}

export interface CreateMedicationLogRequest {
  readonly status: MedicationLogStatusApi;
  readonly dose?: string | null;
  readonly prnReason?: string | null;
  readonly scheduledFor?: string | null;
}
export interface CreateMedicationLogResponse {
  readonly log: MedicationLogDto;
}

export interface ScheduleSlotDto {
  readonly medicationId: string;
  readonly name: string;
  readonly scheduledFor: string | null;
  readonly asNeeded: boolean;
  readonly status: "pending" | "taken" | "skipped";
  /**
   * Number of PRN ("as needed") doses logged for this med on the slot's date. Present on
   * as_needed slots; omitted on scheduled slots. Optional for backward-compat — older payloads
   * without it are valid and consumers should treat a missing value as 0.
   */
  readonly prnCount?: number;
}
export interface MedicationScheduleResponse {
  readonly date: string;
  readonly slots: readonly ScheduleSlotDto[];
}

// ── Adherence Summary DTOs ─────────────────────────────────────────────────
export interface AdherenceDoseSummaryItemDto {
  readonly medicationId: string;
  readonly name: string;
  readonly status: "pending" | "taken" | "skipped";
  readonly prn: boolean;
}

export interface DayAdherenceSummaryDto {
  readonly date: string;
  readonly scheduledCount: number;
  readonly takenCount: number;
  readonly doses: readonly AdherenceDoseSummaryItemDto[];
}

export interface MedicationAdherenceSummaryResponse {
  readonly days: readonly DayAdherenceSummaryDto[];
}

export interface WellnessAiConsentResponse {
  readonly effective: boolean;
  readonly explicit: boolean | null;
}

export interface PutWellnessAiConsentRequest {
  readonly granted: boolean;
}

// ── Wellness Insights DTOs ────────────────────────────────────────────────

export interface WellnessInsightDto {
  readonly key: string;
  readonly icon: string;
  readonly tone: "pine" | "amber" | "steel";
  readonly lead: string;
  readonly rest: string;
  readonly emotion?: WellnessEmotionCore;
  readonly action?: string;
}

export interface WellnessInsightsResponse {
  readonly insights: readonly WellnessInsightDto[];
}

// ── Therapy Notes DTOs ────────────────────────────────────────────────────

export interface TherapyNoteDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly body: string;
  readonly linkedCheckinId: string | null;
  readonly linkedEmotion: WellnessEmotionCore | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface CreateTherapyNoteRequest {
  readonly body: string;
  readonly linkedCheckinId?: string | null;
  readonly linkedEmotion?: WellnessEmotionCore | null;
}

export interface CreateTherapyNoteResponse {
  readonly note: TherapyNoteDto;
}

export interface ListTherapyNotesResponse {
  readonly notes: readonly TherapyNoteDto[];
}

export interface DeleteTherapyNoteResponse {
  readonly deleted: boolean;
}

// ── Selective Wellness Export DTOs (#484) ───────────────────────────────────
//
// The category toggle is the redaction unit (spec §3): within a selected category all
// records in the [from, to] window are included; unselected categories are absent.
// `from`/`to` are inclusive ISO date (YYYY-MM-DD) bounds. The job payload itself stays
// metadata-only (CLAUDE.md invariant); from/to/categories also land on the job row's
// `params` column so the worker re-reads them from the DB, not the payload.

export const WELLNESS_EXPORT_CATEGORIES = [
  "checkins",
  "medications",
  "therapyNotes",
  "insights"
] as const;
export type WellnessExportCategory = (typeof WELLNESS_EXPORT_CATEGORIES)[number];

export interface WellnessExportRequest {
  readonly from: string;
  readonly to: string;
  readonly categories: readonly WellnessExportCategory[];
}

export interface WellnessExportResponse {
  readonly jobId: string;
  readonly status: string;
}

// ── JSON schemas ────────────────────────────────────────────────────────────

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const nullableIntensitySchema = {
  anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }]
} as const;

export const feelingCoreSchema = { type: "string", enum: WELLNESS_EMOTION_CORES } as const;
export const medicationFrequencyTypeSchema = {
  type: "string",
  enum: MEDICATION_FREQUENCY_TYPES
} as const;
export const medicationLogStatusSchema = {
  type: "string",
  enum: MEDICATION_LOG_STATUSES
} as const;

const insightToneSchema = { type: "string", enum: ["pine", "amber", "steel"] } as const;

export const wellnessInsightDtoSchema = {
  type: "object",
  required: ["key", "icon", "tone", "lead", "rest"],
  properties: {
    key: { type: "string" },
    icon: { type: "string" },
    tone: insightToneSchema,
    lead: { type: "string" },
    rest: { type: "string" },
    emotion: feelingCoreSchema,
    action: { type: "string" }
  }
} as const;

export const wellnessInsightsResponseSchema = {
  type: "object",
  required: ["insights"],
  properties: { insights: { type: "array", items: wellnessInsightDtoSchema } }
} as const;

export const therapyNoteDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "body",
    "linkedCheckinId",
    "linkedEmotion",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    body: { type: "string" },
    linkedCheckinId: nullableStringSchema,
    linkedEmotion: { anyOf: [feelingCoreSchema, { type: "null" }] },
    createdAt: nullableStringSchema,
    updatedAt: nullableStringSchema
  }
} as const;

export const createTherapyNoteRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: { type: "string" },
    linkedCheckinId: nullableStringSchema,
    linkedEmotion: { anyOf: [feelingCoreSchema, { type: "null" }] }
  }
} as const;

export const createTherapyNoteResponseSchema = {
  type: "object",
  required: ["note"],
  properties: { note: therapyNoteDtoSchema }
} as const;

export const listTherapyNotesResponseSchema = {
  type: "object",
  required: ["notes"],
  properties: { notes: { type: "array", items: therapyNoteDtoSchema } }
} as const;

export const deleteTherapyNoteResponseSchema = {
  type: "object",
  required: ["deleted"],
  properties: { deleted: { type: "boolean" } }
} as const;

// ── Selective Wellness Export schemas (#484) ────────────────────────────────
const isoDatePattern = "^\\d{4}-\\d{2}-\\d{2}$";

export const wellnessExportRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "categories"],
  properties: {
    from: { type: "string", pattern: isoDatePattern },
    to: { type: "string", pattern: isoDatePattern },
    categories: {
      type: "array",
      items: { type: "string", enum: WELLNESS_EXPORT_CATEGORIES },
      minItems: 1
    }
  }
} as const;

export const wellnessExportResponseSchema = {
  type: "object",
  required: ["jobId", "status"],
  properties: {
    jobId: { type: "string" },
    status: { type: "string" }
  }
} as const;

export const medicationLogDtoSchema = {
  type: "object",
  required: ["id", "medicationId", "status", "dose", "prnReason", "scheduledFor", "loggedAt"],
  properties: {
    id: { type: "string" },
    medicationId: { type: "string" },
    status: medicationLogStatusSchema,
    dose: nullableStringSchema,
    prnReason: nullableStringSchema,
    scheduledFor: nullableStringSchema,
    loggedAt: nullableStringSchema
  }
} as const;

export const adherenceDoseSummaryItemDtoSchema = {
  type: "object",
  required: ["medicationId", "name", "status", "prn"],
  properties: {
    medicationId: { type: "string" },
    name: { type: "string" },
    status: { type: "string", enum: ["pending", "taken", "skipped"] },
    prn: { type: "boolean" }
  }
} as const;

export const dayAdherenceSummaryDtoSchema = {
  type: "object",
  required: ["date", "scheduledCount", "takenCount", "doses"],
  properties: {
    date: { type: "string" },
    scheduledCount: { type: "number" },
    takenCount: { type: "number" },
    doses: { type: "array", items: adherenceDoseSummaryItemDtoSchema }
  }
} as const;

export const medicationAdherenceSummaryResponseSchema = {
  type: "object",
  required: ["days"],
  properties: { days: { type: "array", items: dayAdherenceSummaryDtoSchema } }
} as const;

export const wellnessAiConsentResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["effective", "explicit"],
  properties: {
    effective: { type: "boolean" },
    explicit: { anyOf: [{ type: "boolean" }, { type: "null" }] }
  }
} as const;

export const putWellnessAiConsentRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["granted"],
  properties: {
    granted: { type: "boolean" }
  }
} as const;

export const updateCheckinRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feelingCore"],
  properties: {
    feelingCore: feelingCoreSchema,
    feelingSecondary: nullableStringSchema,
    feelingTertiary: nullableStringSchema,
    sensations: stringArraySchema,
    intensity: nullableIntensitySchema,
    energy: nullableIntensitySchema,
    note: nullableStringSchema
  }
} as const;

export const checkinDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "checkedInAt",
    "feelingCore",
    "feelingSecondary",
    "feelingTertiary",
    "wheelVersion",
    "sensations",
    "intensity",
    "energy",
    "note",
    "identifiedVia",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    checkedInAt: nullableStringSchema,
    feelingCore: feelingCoreSchema,
    feelingSecondary: nullableStringSchema,
    feelingTertiary: nullableStringSchema,
    wheelVersion: { type: "string" },
    sensations: stringArraySchema,
    intensity: { anyOf: [{ type: "number" }, { type: "null" }] },
    energy: { anyOf: [{ type: "number" }, { type: "null" }] },
    note: nullableStringSchema,
    identifiedVia: { type: "string", enum: ["wheel", "assisted"] },
    createdAt: nullableStringSchema
  }
} as const;

export const updateCheckinResponseSchema = {
  type: "object",
  required: ["checkin"],
  properties: { checkin: checkinDtoSchema }
} as const;

export const createCheckinRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feelingCore"],
  properties: {
    feelingCore: feelingCoreSchema,
    feelingSecondary: nullableStringSchema,
    feelingTertiary: nullableStringSchema,
    sensations: stringArraySchema,
    intensity: nullableIntensitySchema,
    energy: nullableIntensitySchema,
    note: nullableStringSchema,
    identifiedVia: { type: "string", enum: ["wheel", "assisted"] }
  }
} as const;

export const createCheckinResponseSchema = {
  type: "object",
  required: ["checkin"],
  properties: { checkin: checkinDtoSchema }
} as const;

export const listCheckinsResponseSchema = {
  type: "object",
  required: ["checkins"],
  properties: { checkins: { type: "array", items: checkinDtoSchema } }
} as const;

export const medicationDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "name",
    "dosage",
    "form",
    "frequencyType",
    "timesPerDay",
    "intervalHours",
    "weekdays",
    "scheduleTimes",
    "cycleDaysOn",
    "cycleDaysOff",
    "cycleAnchorDate",
    "active",
    "notes",
    "scheduleStartDate",
    "scheduleEndDate",
    "timeZone",
    "intervalUnit",
    "intervalCount",
    "monthKind",
    "monthDay",
    "monthDayIsLast",
    "monthWeekdayPosition",
    "monthWeekday",
    "remindersEnabled",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    frequencyType: medicationFrequencyTypeSchema,
    timesPerDay: { anyOf: [{ type: "number" }, { type: "null" }] },
    intervalHours: { anyOf: [{ type: "number" }, { type: "null" }] },
    weekdays: { anyOf: [{ type: "array", items: { type: "number" } }, { type: "null" }] },
    scheduleTimes: { anyOf: [stringArraySchema, { type: "null" }] },
    cycleDaysOn: { anyOf: [{ type: "number" }, { type: "null" }] },
    cycleDaysOff: { anyOf: [{ type: "number" }, { type: "null" }] },
    cycleAnchorDate: nullableStringSchema,
    active: { type: "boolean" },
    notes: nullableStringSchema,
    scheduleStartDate: nullableStringSchema,
    scheduleEndDate: nullableStringSchema,
    timeZone: nullableStringSchema,
    intervalUnit: {
      anyOf: [{ type: "string", enum: ["days", "weeks", "months"] }, { type: "null" }]
    },
    intervalCount: { anyOf: [{ type: "number" }, { type: "null" }] },
    monthKind: { anyOf: [{ type: "string", enum: ["date", "weekdayPosition"] }, { type: "null" }] },
    monthDay: { anyOf: [{ type: "number" }, { type: "null" }] },
    monthDayIsLast: { type: "boolean" },
    monthWeekdayPosition: {
      anyOf: [
        { type: "string", enum: ["first", "second", "third", "fourth", "last"] },
        { type: "null" }
      ]
    },
    monthWeekday: { anyOf: [{ type: "number" }, { type: "null" }] },
    remindersEnabled: { type: "boolean" },
    createdAt: nullableStringSchema,
    updatedAt: nullableStringSchema
  }
} as const;

/**
 * The schedule half of a medication request body, shared by create and update so an edit is
 * validated by exactly the same rules as a create (#1968). Ranges mirror the DB CHECKs, so an
 * out-of-range value is a friendly 400 rather than a 500 from the database.
 */
export const medicationScheduleRequestProperties = {
  frequencyType: medicationFrequencyTypeSchema,
  timesPerDay: { anyOf: [{ type: "integer", minimum: 1, maximum: 24 }, { type: "null" }] },
  intervalHours: { anyOf: [{ type: "integer", minimum: 1, maximum: 24 }, { type: "null" }] },
  weekdays: {
    anyOf: [{ type: "array", items: { type: "integer", minimum: 1, maximum: 7 } }, { type: "null" }]
  },
  scheduleTimes: { anyOf: [stringArraySchema, { type: "null" }] },
  cycleDaysOn: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  cycleDaysOff: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  cycleAnchorDate: nullableStringSchema,
  intervalUnit: {
    anyOf: [{ type: "string", enum: ["days", "weeks", "months"] }, { type: "null" }]
  },
  intervalCount: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  startDate: nullableStringSchema,
  endDate: nullableStringSchema,
  monthKind: { anyOf: [{ type: "string", enum: ["date", "weekdayPosition"] }, { type: "null" }] },
  monthDay: { anyOf: [{ type: "integer", minimum: 1, maximum: 31 }, { type: "null" }] },
  monthDayIsLast: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  monthWeekdayPosition: {
    anyOf: [
      { type: "string", enum: ["first", "second", "third", "fourth", "last"] },
      { type: "null" }
    ]
  },
  monthWeekday: { anyOf: [{ type: "integer", minimum: 1, maximum: 7 }, { type: "null" }] },
  remindersEnabled: { anyOf: [{ type: "boolean" }, { type: "null" }] }
} as const;

export const createMedicationRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "frequencyType"],
  properties: {
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    notes: nullableStringSchema,
    ...medicationScheduleRequestProperties
  }
} as const;

// An update may now change the schedule (#1968). It accepts the same schedule properties as a
// create; the route enforces the all-or-nothing rule (any schedule field requires frequencyType)
// and the per-type required fields, because JSON Schema alone cannot express the discriminator.
export const updateMedicationRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    dosage: nullableStringSchema,
    form: nullableStringSchema,
    active: { type: "boolean" },
    notes: nullableStringSchema,
    ...medicationScheduleRequestProperties
  }
} as const;

export const medicationResponseSchema = {
  type: "object",
  required: ["medication"],
  properties: { medication: medicationDtoSchema }
} as const;

export const listMedicationsResponseSchema = {
  type: "object",
  required: ["medications"],
  properties: { medications: { type: "array", items: medicationDtoSchema } }
} as const;

export const createMedicationLogRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: medicationLogStatusSchema,
    dose: nullableStringSchema,
    prnReason: nullableStringSchema,
    scheduledFor: nullableStringSchema
  },
  // PRN doses are unscheduled by definition — a scheduledFor on a "prn" log would upsert onto
  // an existing scheduled slot and clobber its taken/skipped record (#770 / M3). Tightened here
  // as defense-in-depth alongside the route's explicit parse-time rejection.
  if: {
    properties: { status: { const: "prn" } },
    required: ["status"]
  },
  then: {
    properties: { scheduledFor: { type: "null" } }
  }
} as const;

export const createMedicationLogResponseSchema = {
  type: "object",
  required: ["log"],
  properties: { log: medicationLogDtoSchema }
} as const;

export const scheduleSlotDtoSchema = {
  type: "object",
  // prnCount is intentionally NOT required — additive, backward-compatible field.
  required: ["medicationId", "name", "scheduledFor", "asNeeded", "status"],
  properties: {
    medicationId: { type: "string" },
    name: { type: "string" },
    scheduledFor: nullableStringSchema,
    asNeeded: { type: "boolean" },
    status: { type: "string", enum: ["pending", "taken", "skipped"] },
    prnCount: { type: "number" }
  }
} as const;

export const medicationScheduleResponseSchema = {
  type: "object",
  required: ["date", "slots"],
  properties: {
    date: { type: "string" },
    slots: { type: "array", items: scheduleSlotDtoSchema }
  }
} as const;

// ── Route schemas (Fastify {request?, response} envelopes) ───────────────────

export const createCheckinRouteSchema = {
  body: createCheckinRequestSchema,
  response: { 201: createCheckinResponseSchema, 400: errorResponseSchema }
} as const;
export const listCheckinsRouteSchema = {
  response: { 200: listCheckinsResponseSchema }
} as const;
export const createMedicationRouteSchema = {
  body: createMedicationRequestSchema,
  response: { 201: medicationResponseSchema, 400: errorResponseSchema }
} as const;
export const listMedicationsRouteSchema = {
  response: { 200: listMedicationsResponseSchema }
} as const;
export const updateMedicationRouteSchema = {
  body: updateMedicationRequestSchema,
  response: { 200: medicationResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema }
} as const;
export const medicationScheduleRouteSchema = {
  response: { 200: medicationScheduleResponseSchema }
} as const;
export const createMedicationLogRouteSchema = {
  body: createMedicationLogRequestSchema,
  response: {
    201: createMedicationLogResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;
export const wellnessInsightsRouteSchema = {
  response: { 200: wellnessInsightsResponseSchema }
} as const;
export const listTherapyNotesRouteSchema = {
  response: { 200: listTherapyNotesResponseSchema }
} as const;
export const createTherapyNoteRouteSchema = {
  body: createTherapyNoteRequestSchema,
  response: {
    201: createTherapyNoteResponseSchema,
    400: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
export const deleteTherapyNoteRouteSchema = {
  response: { 200: deleteTherapyNoteResponseSchema, 404: errorResponseSchema }
} as const;
export const medicationAdherenceSummaryRouteSchema = {
  response: { 200: medicationAdherenceSummaryResponseSchema }
} as const;
export const updateCheckinRouteSchema = {
  body: updateCheckinRequestSchema,
  response: { 200: updateCheckinResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema }
} as const;

// ── Browser-safe reference taxonomy ──────────────────────────────────────────
// Lives in @moss/shared (NOT @moss/wellness) so the web bundle never imports the
// server-only wellness index, whose manifest pulls `node:url` (Codex R1: bundle bloat/break).
// Emotion taxonomy (core emotion → feelings → body sensations) adapted from an
// emotion–sensation reference wheel. Values are original to this design.

/** polarity × intensity(1-5) → mood index (−5…+5) */
export const EMOTION_POLARITY: Readonly<Record<WellnessEmotionCore, number>> = {
  happy: 1.0,
  sad: -1.0,
  fear: -0.8,
  anger: -0.7,
  disgust: -0.7,
  surprise: 0.2
};

/** mood index = round(polarity × intensity, 1). Range −5…+5. */
export function moodIndex(core: WellnessEmotionCore, intensity: number): number {
  const polarity = EMOTION_POLARITY[core] ?? 0;
  return Math.round(polarity * intensity * 10) / 10;
}

export type MoodBand = "bright" | "lifted" | "even" | "low" | "heavy";

/** Map a mood-index value to a named band. */
export function moodBand(x: number): MoodBand {
  if (x >= 3) return "bright";
  if (x >= 1) return "lifted";
  if (x > -1) return "even";
  if (x > -3) return "low";
  return "heavy";
}

export interface EmotionFeeling {
  readonly label: string;
  readonly sensations: readonly string[];
}

export interface EmotionEntry {
  readonly core: WellnessEmotionCore;
  readonly polarity: number;
  readonly blurb: string;
  readonly feelings: readonly EmotionFeeling[];
}

export const EMOTIONS: readonly EmotionEntry[] = [
  {
    core: "happy",
    polarity: 1.0,
    blurb: "open, warm, at ease",
    feelings: [
      { label: "Joy", sensations: ["Open", "Energetic"] },
      { label: "Curious", sensations: ["Awake", "Brow-furrow"] },
      { label: "Proud", sensations: ["Inflated", "Tall"] },
      { label: "Satisfied", sensations: ["Soft", "Calm"] },
      { label: "Courageous", sensations: ["Jaw set", "Steady"] },
      { label: "Peaceful", sensations: ["Relaxed", "Still"] },
      { label: "Intimate", sensations: ["Sensitive", "Warm"] },
      { label: "Optimistic", sensations: ["Light", "Buzzing"] }
    ]
  },
  {
    core: "sad",
    polarity: -1.0,
    blurb: "heavy, slow, withdrawn",
    feelings: [
      { label: "Guilt", sensations: ["Looking down", "Empty"] },
      { label: "Abandoned", sensations: ["Curling up", "Slouching"] },
      { label: "Despair", sensations: ["Crying", "Body aches"] },
      { label: "Depressed", sensations: ["Tiredness", "Hollow feeling"] },
      { label: "Lonely", sensations: ["Slow heart", "Heaviness"] },
      { label: "Apathetic", sensations: ["Weak", "Eye rolls"] }
    ]
  },
  {
    core: "fear",
    polarity: -0.8,
    blurb: "braced, jittery, unsure",
    feelings: [
      { label: "Scared", sensations: ["Trembling", "Numb hands"] },
      { label: "Anxious", sensations: ["Fidgety", "Foot-tapping"] },
      { label: "Insecure", sensations: ["Racing heart", "Quiet"] },
      { label: "Inferior", sensations: ["Frozen", "Tense"] },
      { label: "Unwanted", sensations: ["Cold", "Unsteady"] },
      { label: "Embarrassed", sensations: ["Blushing", "Tender"] }
    ]
  },
  {
    core: "anger",
    polarity: -0.7,
    blurb: "hot, tight, pushed",
    feelings: [
      { label: "Hurt", sensations: ["Lip-tremble", "Limp"] },
      { label: "Insecure", sensations: ["Hiding", "Hot"] },
      { label: "Hateful", sensations: ["Scowl", "Turning away"] },
      { label: "Mad", sensations: ["Loud words", "Flushed"] },
      { label: "Aggressive", sensations: ["Racing heart", "Clenching"] },
      { label: "Irritated", sensations: ["Tight jaw", "Headache"] },
      { label: "Distant", sensations: ["Numb", "Gut-turning"] },
      { label: "Critical", sensations: ["Feeling hot", "Lip curled"] }
    ]
  },
  {
    core: "disgust",
    polarity: -0.7,
    blurb: "recoiling, queasy, done",
    feelings: [
      { label: "Disapproval", sensations: ["Shuddering", "Writhing"] },
      { label: "Disappointed", sensations: ["Need to move", "Face-scrunched"] },
      { label: "Awful", sensations: ["Nausea", "Lump in throat"] },
      { label: "Aversion", sensations: ["Queasy", "Turn away"] }
    ]
  },
  {
    core: "surprise",
    polarity: 0.2,
    blurb: "wide-eyed, alert, struck",
    feelings: [
      { label: "Shock", sensations: ["Jumpy", "Sweaty palms"] },
      { label: "Confusion", sensations: ["Breathless", "Speechless"] },
      { label: "Awe", sensations: ["Jaw drop", "Eyebrows up"] },
      { label: "Excitement", sensations: ["Electrified", "Jumpy"] }
    ]
  }
];

/** Curated interoception "body check" list (static reference data, NOT a table). */
export const BODY_SENSATIONS: readonly string[] = [
  "Tight chest",
  "Racing heart",
  "Lump in throat",
  "Clenched jaw",
  "Stiff shoulders",
  "Butterflies / fluttering stomach",
  "Sweating",
  "Dry mouth",
  "Shallow breathing",
  "Heaviness / fatigue",
  "Restlessness",
  "Temperature change (hot/cold)"
];

/**
 * Validate a (core, secondary?, tertiary?) selection against EMOTIONS. Returns true
 * for a bare core or a core+valid-secondary. Tertiary MUST be null/undefined — the new
 * taxonomy is 2-level only (core → feeling). Browser-safe (no node:*).
 */
export function isValidFeelingPath(
  core: WellnessEmotionCore,
  secondary?: string | null,
  tertiary?: string | null
): boolean {
  // tertiary is disallowed in the new 2-level taxonomy
  if (tertiary != null) return false;
  const coreEntry = EMOTIONS.find((e) => e.core === core);
  if (!coreEntry) return false;
  if (secondary == null) return true;
  return coreEntry.feelings.some((f) => f.label === secondary);
}
