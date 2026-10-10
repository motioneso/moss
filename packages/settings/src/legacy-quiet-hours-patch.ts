import { isDeepStrictEqual } from "node:util";

import type { DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { ProactiveMonitoringPreferenceV1 } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { QUIET_HOURS_PREFERENCE_KEY, isStrictLocalTime } from "./quiet-hours-application.js";
import { withQuietHoursMarker, type QuietHoursAuthorityRead } from "./quiet-hours-authority.js";
import {
  displayedQuietHours,
  readQuietHoursForWrite,
  saveQuietHours
} from "./quiet-hours-writer.js";

type NestedQuietHours = ProactiveMonitoringPreferenceV1["quietHours"];

export interface LegacyQuietHoursPatchResult {
  /** "profile" when the one quiet-hours record took the edit, so the alert record must not. */
  readonly target: "profile" | "nested";
}

const preferences = new PreferencesRepository();

/**
 * Applies the quiet-hours part of a legacy alert-settings PATCH under the shared quiet-hours lock.
 * An unambiguous owner edits the one Profile record. A conflict keeps writing the older nested
 * schedule and freezes Profile as unresolved, so this edit cannot settle the conflict by itself.
 * A malformed record keeps today's nested behaviour.
 */
export async function applyLegacyQuietHoursPatch(
  scopedDb: DataContextDb,
  patch: Partial<NestedQuietHours> | undefined
): Promise<LegacyQuietHoursPatchResult> {
  const before = await readQuietHoursForWrite(scopedDb);
  const status = before.authority.status;
  if (status === "malformed") return { target: "nested" };
  if (status === "conflict") {
    await freezeUnresolved(scopedDb, before);
    return { target: "nested" };
  }

  const current = displayedQuietHours(before);
  const submitted = objectValue(patch);
  if ("enabled" in submitted && typeof submitted.enabled !== "boolean") {
    throw new HttpError(400, "quietHours.enabled must be true or false");
  }
  const start = "startLocalTime" in submitted ? submitted.startLocalTime : current.start;
  const end = "endLocalTime" in submitted ? submitted.endLocalTime : current.end;
  assertNewQuietTimesValid(
    { startLocalTime: current.start, endLocalTime: current.end },
    start,
    end
  );

  await saveQuietHours(scopedDb, preferences, before, {
    enabled: "enabled" in submitted ? (submitted.enabled as boolean) : current.enabled,
    start: start as string,
    end: end as string,
    timezone: current.timezone
  });
  return { target: "profile" };
}

/**
 * Validates only quiet times the patch changes. Saved legacy values (loose HH:MM, equal times)
 * stay effective until the user edits them.
 */
export function assertNewQuietTimesValid(
  effective: Pick<NestedQuietHours, "startLocalTime" | "endLocalTime">,
  start: unknown,
  end: unknown
): void {
  const startChanged = start !== effective.startLocalTime;
  const endChanged = end !== effective.endLocalTime;
  if (startChanged && !isStrictLocalTime(start)) {
    throw new HttpError(400, "quietHours.startLocalTime must be HH:MM (00:00-23:59)");
  }
  if (endChanged && !isStrictLocalTime(end)) {
    throw new HttpError(400, "quietHours.endLocalTime must be HH:MM (00:00-23:59)");
  }
  if ((startChanged || endChanged) && start === end) {
    throw new HttpError(400, "Quiet hours must start and end at different times");
  }
}

async function freezeUnresolved(
  scopedDb: DataContextDb,
  before: QuietHoursAuthorityRead
): Promise<void> {
  const row = before.profileRow;
  if (row === null || !isRecord(row.value)) return;
  const frozen = withQuietHoursMarker(row.value, "unresolved");
  if (isDeepStrictEqual(frozen, row.value)) return;
  await preferences.upsertWithRevision(scopedDb, QUIET_HOURS_PREFERENCE_KEY, frozen, row.revision);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
