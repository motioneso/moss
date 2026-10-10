import { isDeepStrictEqual } from "node:util";

import { HttpError } from "@moss/module-sdk";
import type { QuietHoursSettingsDto } from "@moss/shared";

// Shared by the Profile REST writer and the quietHours.set assistant tool; both write this row.
export const QUIET_HOURS_PREFERENCE_KEY = "quiet-hours";

export const DEFAULT_QUIET_HOURS: QuietHoursSettingsDto = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: null
};

const STRICT_LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isStrictLocalTime(value: unknown): value is string {
  return typeof value === "string" && STRICT_LOCAL_TIME.test(value);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Effective schedule the readers see; invalid stored fields fall back to the defaults. */
export function normalizeQuietHours(value: unknown): QuietHoursSettingsDto {
  if (!isRecord(value)) return DEFAULT_QUIET_HOURS;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : DEFAULT_QUIET_HOURS.enabled;
  const start = isStrictLocalTime(value.start) ? value.start : DEFAULT_QUIET_HOURS.start;
  const end = isStrictLocalTime(value.end) ? value.end : DEFAULT_QUIET_HOURS.end;
  const timezone =
    typeof value.timezone === "string" && value.timezone.length > 0 && value.timezone.length <= 100
      ? value.timezone
      : null;
  return { enabled, start, end, timezone };
}

/**
 * Opaque write expectation for the Profile row. The revision alone repeats after an undo deletes
 * a created row and a later write recreates it at revision 1; updated_at separates those rows.
 */
export function quietHoursVersion(
  row: { revision: number; updatedAt: Date } | null
): string | null {
  return row ? `${row.revision}:${row.updatedAt.getTime()}` : null;
}

/**
 * Applies a full submitted schedule to the stored raw value. Fields that match the current
 * effective value keep their raw stored form (including absence and legacy invalid values), so an
 * unrelated edit never rewrites them. Only newly supplied fields are validated.
 */
export function applyQuietHoursEdit(
  currentRaw: unknown,
  submitted: QuietHoursSettingsDto,
  hasRow: boolean
): { next: Record<string, unknown>; effective: QuietHoursSettingsDto; changed: boolean } {
  const current = normalizeQuietHours(currentRaw);
  const base: Record<string, unknown> = hasRow && isRecord(currentRaw) ? { ...currentRaw } : {};
  const timezone = normalizeSubmittedTimeZone(submitted.timezone);
  const supplied = {
    enabled: !hasRow || submitted.enabled !== current.enabled,
    start: !hasRow || submitted.start !== current.start,
    end: !hasRow || submitted.end !== current.end,
    timezone: !hasRow || timezone !== current.timezone
  };

  if (supplied.start && !isStrictLocalTime(submitted.start)) {
    throw new HttpError(400, "start must be HH:MM (00:00-23:59)");
  }
  if (supplied.end && !isStrictLocalTime(submitted.end)) {
    throw new HttpError(400, "end must be HH:MM (00:00-23:59)");
  }
  if (supplied.timezone && timezone !== null && !isValidTimeZone(timezone)) {
    throw new HttpError(400, "timezone must be a valid IANA time zone");
  }
  if ((supplied.start || supplied.end) && submitted.start === submitted.end) {
    throw new HttpError(400, "Quiet hours must start and end at different times");
  }

  if (supplied.enabled) base.enabled = submitted.enabled;
  if (supplied.start) base.start = submitted.start;
  if (supplied.end) base.end = submitted.end;
  if (supplied.timezone) base.timezone = timezone;

  const changed = !hasRow || !isDeepStrictEqual(base, currentRaw);
  return { next: base, effective: normalizeQuietHours(base), changed };
}

function normalizeSubmittedTimeZone(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
