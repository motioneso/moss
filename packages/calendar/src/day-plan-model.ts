// Day-plan storage model (R2.2-T01). Pure validation and normalization for the
// Calendar-owned draft aggregate. No database or provider access here.
import {
  DAY_PLAN_BLOCK_KINDS,
  DAY_PLAN_COMMITMENT_DECISIONS,
  DAY_PLAN_CORRECTION_SOURCES,
  DAY_PLAN_INTENT_CAPACITIES,
  DAY_PLAN_OPERATION_KINDS,
  DAY_PLAN_OPERATION_OUTCOMES,
  DAY_PLAN_PENDING_KINDS,
  DAY_RE,
  type DayPlanActualPlacement,
  type DayPlanBlockInput,
  type DayPlanEveningIntent,
  type DayPlanIntentCorrection,
  type DayPlanOpenCommitment,
  type DayPlanOperationKind,
  type DayPlanOperationOutcome,
  type DayPlanPendingChange
} from "@moss/shared";

export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 12 * 60;

export class DayPlanValidationError extends Error {
  readonly code = "day_plan_invalid";

  constructor(message: string) {
    super(message);
    this.name = "DayPlanValidationError";
  }
}

export function normalizeLocalDay(value: unknown): string {
  if (typeof value !== "string") {
    throw new DayPlanValidationError("localDay must use YYYY-MM-DD");
  }
  const trimmed = value.trim();
  if (!DAY_RE.test(trimmed)) {
    throw new DayPlanValidationError("localDay must use YYYY-MM-DD");
  }
  const probe = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== trimmed) {
    throw new DayPlanValidationError("localDay is not a real calendar date");
  }
  return trimmed;
}

export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string") {
    throw new DayPlanValidationError("timeZone must be a valid IANA name");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new DayPlanValidationError("timeZone must be a non-empty IANA name");
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
  } catch {
    throw new DayPlanValidationError("timeZone must be a valid IANA name");
  }
  return trimmed;
}

export function normalizeDurationMinutes(value: number): number {
  if (!Number.isInteger(value) || value < MIN_DURATION_MINUTES || value > MAX_DURATION_MINUTES) {
    throw new DayPlanValidationError(
      `durationMinutes must be an integer between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStartsAt(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DayPlanValidationError(`${field} must be a non-empty timestamp`);
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(trimmed)) {
    throw new DayPlanValidationError(`${field} must be an ISO instant`);
  }
  const parsed = new Date(trimmed);
  const canonical = trimmed.includes(".") ? trimmed : trimmed.replace("Z", ".000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    throw new DayPlanValidationError(`${field} must be an ISO instant`);
  }
  return trimmed;
}

export function normalizeSourceRunId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DayPlanValidationError("sourceRunId must be an id or null");
  }
  return value.trim();
}

export function normalizeActualPlacement(value: unknown): DayPlanActualPlacement | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new DayPlanValidationError("actualPlacement must be an object");
  const startsAt =
    value.startsAt === null || value.startsAt === undefined
      ? null
      : normalizeStartsAt(value.startsAt, "actualPlacement.startsAt");
  const durationMinutes =
    value.durationMinutes === null || value.durationMinutes === undefined
      ? null
      : normalizeDurationMinutes(value.durationMinutes as number);
  const calendarEventRef =
    value.calendarEventRef === null || value.calendarEventRef === undefined
      ? null
      : String(value.calendarEventRef).trim() || null;
  return { startsAt, durationMinutes, calendarEventRef };
}

export function normalizePendingChange(value: unknown): DayPlanPendingChange | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new DayPlanValidationError("pendingChange must carry a kind");
  }
  if (!(DAY_PLAN_PENDING_KINDS as readonly string[]).includes(value.kind)) {
    throw new DayPlanValidationError("pendingChange.kind must be add, move or remove");
  }
  if (value.kind === "remove") return { kind: "remove" };
  return {
    kind: value.kind as "add" | "move",
    startsAt: normalizeStartsAt(value.startsAt, "pendingChange.startsAt"),
    durationMinutes: normalizeDurationMinutes(value.durationMinutes as number)
  };
}

function normalizeTaskId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DayPlanValidationError(`${field} must be a task id or null`);
  }
  return value.trim();
}

function normalizeStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new DayPlanValidationError(`${field} must be a list`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new DayPlanValidationError(`${field} must hold non-empty strings`);
    }
    return entry.trim();
  });
}

export function normalizeCorrection(value: unknown): DayPlanIntentCorrection {
  if (!isRecord(value)) throw new DayPlanValidationError("corrections must hold objects");
  if (typeof value.note !== "string" || value.note.trim().length === 0) {
    throw new DayPlanValidationError("corrections must carry a non-empty note");
  }
  if (!(DAY_PLAN_CORRECTION_SOURCES as readonly string[]).includes(String(value.source))) {
    throw new DayPlanValidationError("corrections must carry a known source");
  }
  return {
    taskId: normalizeTaskId(value.taskId, "corrections.taskId"),
    note: value.note.trim(),
    source: value.source as DayPlanIntentCorrection["source"]
  };
}

export function normalizeCommitment(value: unknown): DayPlanOpenCommitment {
  if (!isRecord(value)) throw new DayPlanValidationError("commitments must hold objects");
  const taskId = normalizeTaskId(value.taskId, "commitments.taskId");
  if (taskId === null) throw new DayPlanValidationError("commitments must reference a task");
  if (!(DAY_PLAN_COMMITMENT_DECISIONS as readonly string[]).includes(String(value.decision))) {
    throw new DayPlanValidationError("commitments must carry a known decision");
  }
  return { taskId, decision: value.decision as DayPlanOpenCommitment["decision"] };
}

export function emptyEveningIntent(): DayPlanEveningIntent {
  return { priorityTaskIds: [], capacity: null, notes: null, corrections: [], commitments: [] };
}

function normalizeIntentField<T>(
  input: Partial<DayPlanEveningIntent> | null | undefined,
  current: DayPlanEveningIntent,
  field: "priorityTaskIds" | "corrections" | "commitments",
  normalize: (value: unknown) => T
): T {
  if (input === undefined || input === null || input[field] === undefined)
    return current[field] as unknown as T;
  return normalize(input[field]);
}

// Merges one evening-intent patch over the stored intent. Omission keeps the
// stored value, an explicit null clears nullable fields, an explicit empty
// list clears that list, and a null patch resets the whole intent.
export function mergeEveningIntent(
  current: DayPlanEveningIntent | null,
  patch: Partial<DayPlanEveningIntent> | null | undefined
): DayPlanEveningIntent | null {
  const base = current ?? emptyEveningIntent();
  if (patch === undefined) return current;
  if (patch === null) return emptyEveningIntent();
  if (!isRecord(patch)) throw new DayPlanValidationError("eveningIntent must be an object");
  const capacity =
    patch.capacity === undefined
      ? base.capacity
      : patch.capacity === null
        ? null
        : (DAY_PLAN_INTENT_CAPACITIES as readonly string[]).includes(patch.capacity)
          ? patch.capacity
          : (() => {
              throw new DayPlanValidationError("capacity must be light, normal or full");
            })();
  const notes =
    patch.notes === undefined
      ? base.notes
      : patch.notes === null
        ? null
        : typeof patch.notes === "string" && patch.notes.trim().length > 0
          ? patch.notes.trim()
          : (() => {
              throw new DayPlanValidationError("notes must be non-empty text or null");
            })();
  return {
    priorityTaskIds: normalizeIntentField(patch, base, "priorityTaskIds", (v) =>
      normalizeStringList(v, "priorityTaskIds")
    ),
    capacity,
    notes,
    corrections: normalizeIntentField(patch, base, "corrections", (v) =>
      Array.isArray(v)
        ? v.map(normalizeCorrection)
        : (() => {
            throw new DayPlanValidationError("corrections must be a list");
          })()
    ),
    commitments: normalizeIntentField(patch, base, "commitments", (v) =>
      Array.isArray(v)
        ? v.map(normalizeCommitment)
        : (() => {
            throw new DayPlanValidationError("commitments must be a list");
          })()
    )
  };
}

export function normalizeEveningIntent(value: unknown): DayPlanEveningIntent | null {
  if (value === null || value === undefined) return null;
  return mergeEveningIntent(emptyEveningIntent(), value as Partial<DayPlanEveningIntent>);
}

export function normalizeBlockInput(
  block: DayPlanBlockInput,
  index: number
): {
  id: string | undefined;
  kind: DayPlanBlockInput["kind"];
  taskId: string | null;
  title: string | null;
  position: number;
  pendingChange: DayPlanPendingChange | null;
} {
  if (!isRecord(block)) throw new DayPlanValidationError(`blocks[${index}] must be an object`);
  if (!(DAY_PLAN_BLOCK_KINDS as readonly string[]).includes(String(block.kind))) {
    throw new DayPlanValidationError("blocks must carry a known kind");
  }
  // Recorded placement is never writable through a draft; any supplied value
  // is rejected so fixtures seed it straight into storage instead.
  if ("actualPlacement" in block) {
    throw new DayPlanValidationError("blocks must not set actualPlacement");
  }
  const title =
    block.title === null || block.title === undefined ? null : String(block.title).trim() || null;
  const position = block.position === undefined ? index : block.position;
  if (!Number.isInteger(position) || position < 0) {
    throw new DayPlanValidationError("blocks must carry a non-negative position");
  }
  return {
    id: block.id,
    kind: block.kind,
    taskId: normalizeTaskId(block.taskId, "blocks.taskId"),
    title,
    position,
    pendingChange: normalizePendingChange(block.pendingChange ?? null)
  };
}

export function normalizeOperationKind(value: unknown): DayPlanOperationKind {
  if (!(DAY_PLAN_OPERATION_KINDS as readonly string[]).includes(String(value))) {
    throw new DayPlanValidationError("operation kind must be add, move or remove");
  }
  return value as DayPlanOperationKind;
}

export function normalizeOperationOutcome(value: unknown): DayPlanOperationOutcome {
  if (!(DAY_PLAN_OPERATION_OUTCOMES as readonly string[]).includes(String(value))) {
    throw new DayPlanValidationError(
      "operation outcome must be pending, applied, failed or unknown"
    );
  }
  return value as DayPlanOperationOutcome;
}

export function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
    throw new DayPlanValidationError("idempotencyKey must be non-empty text");
  }
  return value.trim();
}
