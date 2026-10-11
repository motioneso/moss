import type { QuietHoursSettingsDto, ResolveQuietHoursConflictRequest } from "@moss/shared";

import { normalizeQuietHours } from "./quiet-hours-application.js";
import { withQuietHoursMarker, type QuietHoursAuthorityRead } from "./quiet-hours-authority.js";

export type QuietHoursResolutionPlan =
  | { readonly kind: "write"; readonly value: Record<string, unknown> }
  | { readonly kind: "unchanged" }
  | { readonly kind: "stale" };

/**
 * Decides what an owner's conflict choice writes to Profile. Only a live conflict, read at the
 * version the owner saw, with the chosen side still holding the schedule they saw, is settled.
 * A repeat of a choice the canonical schedule already holds writes nothing.
 */
export function planQuietHoursResolution(
  read: QuietHoursAuthorityRead,
  currentVersion: string | null,
  request: ResolveQuietHoursConflictRequest
): QuietHoursResolutionPlan {
  const { authority, profileRow } = read;
  if (authority.status === "canonical") {
    return authority.effective !== null && sameSchedule(authority.effective, request.quietHours)
      ? { kind: "unchanged" }
      : { kind: "stale" };
  }
  if (authority.status !== "conflict" || profileRow === null || !isRecord(profileRow.value)) {
    return { kind: "stale" };
  }
  if (currentVersion !== request.expectedVersion) return { kind: "stale" };

  if (request.choice === "profile") {
    if (!sameSchedule(normalizeQuietHours(profileRow.value), request.quietHours)) {
      return { kind: "stale" };
    }
    return { kind: "write", value: withQuietHoursMarker(profileRow.value, "canonical") };
  }

  // The alert schedule has no zone of its own; it was always read in the owner's zone.
  const alerts = authority.alertsSchedule;
  if (alerts === null) return { kind: "stale" };
  const chosen: QuietHoursSettingsDto = { ...alerts, timezone: null };
  if (!sameSchedule(chosen, request.quietHours)) return { kind: "stale" };
  return { kind: "write", value: withQuietHoursMarker({ ...chosen }, "canonical") };
}

function sameSchedule(a: QuietHoursSettingsDto, b: QuietHoursSettingsDto): boolean {
  return (
    a.enabled === b.enabled &&
    a.start === b.start &&
    a.end === b.end &&
    (a.timezone ?? null) === (b.timezone ?? null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
