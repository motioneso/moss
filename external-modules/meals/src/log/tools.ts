// external-modules/meals/src/log/tools.ts
//
// The meals.log.* tool handlers. list and summarize only read. add saves the entry and queues its
// estimate, so the call returns at once with a pending entry. correct and delete change an entry
// the user already has. Targets come from the self member of the Kitchen and from nowhere else.
import { DEFAULT_LIST_LIMIT, applyListLimit } from "@moss/module-sdk/list-limits";

import type {
  CaptureKind,
  LogEntryResult,
  LogListResult,
  LogSummaryResult,
  LogTargetsView,
  NutrientsView
} from "../contracts.js";
import { calorieFit } from "../domain/targets.js";
import type { CorrectEntryPatch, CorrectItemPatch } from "../store/log-port.js";
import {
  InputError,
  readEnum,
  readInt,
  readNutrientValue,
  readString,
  requireNoUnknownKeys
} from "../tools/validate.js";
import { computeDayTotals, parseConsumedAtInstant, resolveEntryLocalDate } from "./domain.js";
import { LOG_ESTIMATE_JOB_KIND, LOG_ESTIMATE_QUEUE, logEstimateKey } from "./deps.js";
import type { LogDeps } from "./deps.js";

type Input = Record<string, unknown>;

const CAPTURE_KINDS: readonly CaptureKind[] = ["text", "photo", "voice"];
const LIST_MAX_RANGE_DAYS = 31;
const SUMMARIZE_MAX_RANGE_DAYS = 92;
const DESCRIPTION_MAX_BYTES = 2000;
const SERVING_NOTE_MAX_BYTES = 500;
const ITEM_LABEL_MAX_BYTES = 200;
const ITEM_PORTION_MAX_BYTES = 100;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const NO_ENTRY = "There is no log entry with that id";
const STALE = "That entry changed since it was read. Read it again and retry.";

function localDateInput(input: Input, key: string, required: boolean): string | undefined {
  const value = required ? readString(input, key, { required: true }) : readString(input, key);
  if (value === undefined) return undefined;
  if (!LOCAL_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new InputError(`${key} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  return value;
}

function daySpan(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function dateRange(input: Input, maxDays: number): { from: string; to: string } {
  const from = localDateInput(input, "fromLocalDate", true)!;
  const to = localDateInput(input, "toLocalDate", true)!;
  const span = daySpan(from, to);
  if (span < 1) throw new InputError("toLocalDate must not be before fromLocalDate");
  if (span > maxDays) throw new InputError(`date range must not exceed ${maxDays} days`);
  return { from, to };
}

/** The user's own zone first, the model's second, UTC last. */
function resolveTimeZone(deps: LogDeps, fromInput: string | undefined): string {
  return deps.localTimezone ?? fromInput ?? "UTC";
}

function parseConsumedAt(raw: string, zone: string): Date {
  try {
    return parseConsumedAtInstant(raw, zone);
  } catch {
    throw new InputError(
      "consumedAt must be an ISO instant or local date-time; supply an explicit UTC offset for DST gaps or folds"
    );
  }
}

async function targetsOf(deps: LogDeps): Promise<LogTargetsView> {
  const self = (await deps.kitchen()).members.find((member) => member.isSelf);
  return {
    caloriesKcal: self?.calorieTarget ?? null,
    proteinG: self?.macroTargets.proteinG ?? null,
    carbG: self?.macroTargets.carbG ?? null,
    fatG: self?.macroTargets.fatG ?? null
  };
}

// meals.log.list

const LIST_KEYS = new Set(["localDate", "fromLocalDate", "toLocalDate", "limit"]);

export async function logList(deps: LogDeps, input: Input): Promise<LogListResult> {
  requireNoUnknownKeys(input, LIST_KEYS);
  const localDate = localDateInput(input, "localDate", false);
  const from = localDateInput(input, "fromLocalDate", false);
  const to = localDateInput(input, "toLocalDate", false);
  const limit = readInt(input, "limit", { min: 1, max: DEFAULT_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT;
  const targets = await targetsOf(deps);

  if (localDate !== undefined) {
    if (from !== undefined || to !== undefined) {
      throw new InputError("localDate cannot be combined with fromLocalDate/toLocalDate");
    }
    const all = await deps.store.listForLocalDate(localDate);
    // Totalled over the whole day, not the truncated list, because the user compares it to a target.
    const totals = computeDayTotals(localDate, all);
    const kcal = totals.nutrients.caloriesKcal;
    const { items, truncated, totalCount } = applyListLimit(all, limit);
    return {
      entries: items,
      totals,
      targets,
      calorieFit:
        targets.caloriesKcal !== null && kcal !== null
          ? calorieFit(targets.caloriesKcal, kcal)
          : null,
      truncated,
      totalCount
    };
  }

  if (from === undefined || to === undefined) {
    throw new InputError("either localDate or both fromLocalDate and toLocalDate are required");
  }
  const span = daySpan(from, to);
  if (span < 1) throw new InputError("toLocalDate must not be before fromLocalDate");
  if (span > LIST_MAX_RANGE_DAYS) {
    throw new InputError(`date range must not exceed ${LIST_MAX_RANGE_DAYS} days`);
  }
  const all = await deps.store.listForDateRange(from, to);
  const { items, truncated, totalCount } = applyListLimit(all, limit);
  return { entries: items, totals: null, targets, calorieFit: null, truncated, totalCount };
}

// meals.log.summarize

const SUMMARIZE_KEYS = new Set(["fromLocalDate", "toLocalDate"]);

export async function logSummarize(deps: LogDeps, input: Input): Promise<LogSummaryResult> {
  requireNoUnknownKeys(input, SUMMARIZE_KEYS);
  const { from, to } = dateRange(input, SUMMARIZE_MAX_RANGE_DAYS);
  const entries = await deps.store.listForDateRange(from, to);
  const totals = computeDayTotals(from, entries);
  return {
    fromLocalDate: from,
    toLocalDate: to,
    nutrients: totals.nutrients,
    incomplete: totals.incomplete,
    entriesWithoutEstimate: totals.entriesWithoutEstimate,
    daysWithEntries: new Set(entries.map((entry) => entry.localDate)).size
  };
}

// meals.log.add

const ADD_KEYS = new Set([
  "description",
  "consumedAt",
  "timeZone",
  "captureKind",
  "servingNote",
  "idempotencyKey"
]);

export async function logAdd(deps: LogDeps, input: Input): Promise<LogEntryResult> {
  requireNoUnknownKeys(input, ADD_KEYS);
  const description = readString(input, "description", {
    required: true,
    maxBytes: DESCRIPTION_MAX_BYTES
  });
  if (description.trim().length === 0) throw new InputError("description must not be blank");
  const idempotencyKey = readString(input, "idempotencyKey", { required: true });
  const consumedAtRaw = readString(input, "consumedAt");
  const zone = resolveTimeZone(deps, readString(input, "timeZone"));
  const captureKind = readEnum(input, "captureKind", CAPTURE_KINDS) ?? "text";
  const servingNote =
    readString(input, "servingNote", { maxBytes: SERVING_NOTE_MAX_BYTES }) ?? null;

  const consumedAt =
    consumedAtRaw === undefined ? deps.now() : parseConsumedAt(consumedAtRaw, zone);
  const { localDate, timezoneOffset } = resolveEntryLocalDate(consumedAt, zone);

  const { entry, created } = await deps.store.createEntry({
    entryId: deps.newId(),
    consumedAt,
    localDate,
    timezoneOffset,
    description,
    servingNote,
    captureKind,
    idempotencyKey
  });

  // A retry returns the existing entry and queues nothing, so one entry never gets two estimates.
  // The entry is already saved, so a queue that is busy or down leaves it pending for a retry.
  // Failing the call here would invite the caller to log the same meal twice.
  if (created) {
    try {
      await deps.jobs.enqueue({
        queue: LOG_ESTIMATE_QUEUE,
        jobKind: LOG_ESTIMATE_JOB_KIND,
        idempotencyKey: logEstimateKey(entry.entryId, entry.estimateRevision),
        params: { entryId: entry.entryId, revision: entry.estimateRevision }
      });
    } catch {
      // Left pending on purpose.
    }
  }
  return { entry };
}

// meals.log.reestimate

const REESTIMATE_KEYS = new Set(["entryId"]);

export async function logReestimate(deps: LogDeps, input: Input): Promise<LogEntryResult> {
  requireNoUnknownKeys(input, REESTIMATE_KEYS);
  const entryId = readString(input, "entryId", { required: true });
  const entry = await deps.store.getEntry(entryId);
  if (entry === null) throw new InputError(NO_ENTRY);
  // An estimated entry is the user's to correct. A silent re-roll would discard a number they accepted.
  if (entry.estimateState !== "pending" && entry.estimateState !== "failed") return { entry };

  const ready =
    entry.estimateState === "failed"
      ? await deps.store.markPending(entryId, entry.estimateRevision)
      : entry;
  if (ready === null) throw new InputError(STALE);

  const queued = await deps.jobs.enqueue({
    queue: LOG_ESTIMATE_QUEUE,
    jobKind: LOG_ESTIMATE_JOB_KIND,
    idempotencyKey: logEstimateKey(entryId, ready.estimateRevision),
    params: { entryId, revision: ready.estimateRevision }
  });
  if (queued.status === "limited") {
    throw new InputError("Estimating is busy right now. Try again in a minute.");
  }
  return { entry: ready };
}

// meals.log.correct

const CORRECT_KEYS = new Set([
  "entryId",
  "expectedRevision",
  "description",
  "servingNote",
  "consumedAt",
  "timeZone",
  "items"
]);
const CORRECT_ITEM_KEYS = new Set(["label", "portionNote", "nutrients"]);
const NUTRIENT_KEYS = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const satisfies readonly (keyof NutrientsView)[];

function readNutrientsPatch(raw: unknown, path: string): Partial<NutrientsView> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError(`${path} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(NUTRIENT_KEYS as readonly string[]).includes(key)) {
      throw new InputError(`unknown key: ${path}.${key}`);
    }
  }
  const out: Partial<Record<keyof NutrientsView, number | null>> = {};
  for (const key of NUTRIENT_KEYS) {
    const value = readNutrientValue(record, key);
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<NutrientsView>;
}

/** Item i of the list corrects item i of the entry. A null leaves that item alone. */
function readItemsPatch(input: Input): CorrectItemPatch[] | undefined {
  const raw = input["items"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new InputError("items must be an array");
  return raw.map((entry, index) => {
    if (entry === null) return {};
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new InputError(`items[${index}] must be an object or null`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!CORRECT_ITEM_KEYS.has(key)) throw new InputError(`unknown key: items[${index}].${key}`);
    }
    const label = readString(record, "label", { maxBytes: ITEM_LABEL_MAX_BYTES });
    if (label !== undefined && label.trim().length === 0) {
      throw new InputError(`items[${index}].label must not be blank`);
    }
    const portionNote =
      record["portionNote"] === null
        ? null
        : readString(record, "portionNote", { maxBytes: ITEM_PORTION_MAX_BYTES });
    const nutrients = readNutrientsPatch(record["nutrients"], `items[${index}].nutrients`);
    return {
      ...(label !== undefined ? { label } : {}),
      ...(portionNote !== undefined ? { portionNote } : {}),
      ...(nutrients !== undefined ? { nutrients } : {})
    };
  });
}

function withFixedOffset(raw: string, offsetMinutes: number): string {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return raw;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${raw}${sign}${hours}:${minutes}`;
}

export async function logCorrect(deps: LogDeps, input: Input): Promise<LogEntryResult> {
  requireNoUnknownKeys(input, CORRECT_KEYS);
  const entryId = readString(input, "entryId", { required: true });
  const expectedRevision = readInt(input, "expectedRevision", { required: true, min: 1 });
  const description = readString(input, "description", { maxBytes: DESCRIPTION_MAX_BYTES });
  if (description !== undefined && description.trim().length === 0) {
    throw new InputError("description must not be blank");
  }
  const servingNote =
    input["servingNote"] === null
      ? null
      : readString(input, "servingNote", { maxBytes: SERVING_NOTE_MAX_BYTES });
  const consumedAtRaw = readString(input, "consumedAt");
  const zone = deps.localTimezone ?? readString(input, "timeZone");
  const items = readItemsPatch(input);

  let when: { consumedAt: Date; localDate: string; timezoneOffset: number } | undefined;
  if (consumedAtRaw !== undefined) {
    if (zone !== undefined) {
      const consumedAt = parseConsumedAt(consumedAtRaw, zone);
      when = { consumedAt, ...resolveEntryLocalDate(consumedAt, zone) };
    } else {
      // No zone anywhere. The entry's stored offset keeps it on the day it was logged under.
      const existing = await deps.store.getEntry(entryId);
      if (existing === null) throw new InputError(NO_ENTRY);
      const offset = existing.timezoneOffset;
      const consumedAt = parseConsumedAt(withFixedOffset(consumedAtRaw, offset), "UTC");
      const shifted = new Date(consumedAt.getTime() + offset * 60_000);
      when = { consumedAt, localDate: shifted.toISOString().slice(0, 10), timezoneOffset: offset };
    }
  }

  const patch: CorrectEntryPatch = {
    ...(description !== undefined ? { description } : {}),
    ...(servingNote !== undefined ? { servingNote } : {}),
    ...(when ?? {}),
    ...(items !== undefined ? { items } : {})
  };
  const entry = await deps.store.correctEntry(entryId, expectedRevision, patch);
  if (entry === null) throw new InputError(STALE);
  // A correction moves the revision, which makes the queued estimate stale. An entry still waiting
  // for its estimate needs a new job at the new revision or it would wait forever.
  if (entry.estimateState === "pending") {
    await deps.jobs.enqueue({
      queue: LOG_ESTIMATE_QUEUE,
      jobKind: LOG_ESTIMATE_JOB_KIND,
      idempotencyKey: logEstimateKey(entry.entryId, entry.estimateRevision),
      params: { entryId: entry.entryId, revision: entry.estimateRevision }
    });
  }
  return { entry };
}

// meals.log.delete

const DELETE_KEYS = new Set(["entryId"]);

export async function logDelete(
  deps: LogDeps,
  input: Input
): Promise<{ readonly entryId: string; readonly deleted: true }> {
  requireNoUnknownKeys(input, DELETE_KEYS);
  const entryId = readString(input, "entryId", { required: true });
  if (!(await deps.store.deleteEntry(entryId))) throw new InputError(NO_ENTRY);
  return { entryId, deleted: true };
}
