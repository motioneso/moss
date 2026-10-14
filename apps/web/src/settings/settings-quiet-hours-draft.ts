import {
  isValidTimeZone,
  type GetQuietHoursSettingsResponse,
  type PutQuietHoursSettingsRequest,
  type QuietHoursSettingsDto
} from "@moss/shared";

import { ApiError } from "../api/client.js";
import { readError } from "./settings-types.js";

// Rules for the Alerts & quiet hours editor. The server repeats every check; these only let the
// editor explain a problem before sending.

export const QUIET_HOURS_STALE_SAVE_MESSAGE =
  "Quiet hours changed somewhere else, so this change was not saved. The latest schedule is showing now.";

export function isValidQuietHoursTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function quietHoursDraftDirty(
  saved: QuietHoursSettingsDto,
  draft: QuietHoursSettingsDto
): boolean {
  return (
    saved.enabled !== draft.enabled ||
    saved.start !== draft.start ||
    saved.end !== draft.end ||
    saved.timezone !== draft.timezone
  );
}

/** Why the draft cannot be saved, or null. Overnight windows are allowed. */
export function quietHoursDraftProblem(draft: QuietHoursSettingsDto): string | null {
  if (!isValidQuietHoursTime(draft.start) || !isValidQuietHoursTime(draft.end)) {
    return "Enter a start and end time between 00:00 and 23:59.";
  }
  if (draft.start === draft.end) return "Choose different start and end times.";
  if (draft.timezone !== null && !isValidTimeZone(draft.timezone)) {
    return "Choose a time zone from the list.";
  }
  return null;
}

/**
 * One line naming what is in force. While schedules conflict, or a saved record cannot be read,
 * the Profile schedule governs notifications only, so it is never called the saved setting.
 */
export function quietHoursSavedLine(
  loaded: GetQuietHoursSettingsResponse,
  profileTimeZone: string | null
): string {
  const { quietHours, authority } = loaded;
  const governsAll = authority.status !== "conflict" && authority.status !== "malformed";
  if (authority.status === "default") return "Nothing saved yet, so quiet hours are off.";
  const lead = governsAll ? "Saved schedule" : "Notifications follow";
  if (!quietHours.enabled) return `${lead}: quiet hours are off.`;
  const zone = quietHours.timezone
    ? `${quietHours.timezone} time`
    : profileTimeZone
      ? `your profile time zone (${profileTimeZone})`
      : "your profile time zone";
  return `${lead}: every day, ${quietHours.start} to ${quietHours.end}, ${zone}.`;
}

/** The save carries the version the draft was built from, so a newer stored schedule wins. */
export function quietHoursSaveRequest(
  next: QuietHoursSettingsDto,
  loaded: Pick<GetQuietHoursSettingsResponse, "version"> | undefined
): PutQuietHoursSettingsRequest {
  return { quietHours: next, expectedVersion: loaded?.version ?? null };
}

export function isStaleQuietHoursSave(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export function quietHoursSaveFailure(error: unknown): string {
  if (isStaleQuietHoursSave(error)) return QUIET_HOURS_STALE_SAVE_MESSAGE;
  const reason = readError(error).replace(/[.\s]+$/, "");
  return `Quiet hours could not save: ${reason}. Your previous schedule still applies.`;
}
