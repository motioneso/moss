import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { DataContextDb } from "@moss/db";
import type { QuietHoursAuthorityDto, QuietHoursSettingsDto } from "@moss/shared";

import {
  applyQuietHoursEdit,
  normalizeQuietHours,
  QUIET_HOURS_PREFERENCE_KEY,
  quietHoursVersion
} from "./quiet-hours-application.js";
import {
  localeFreezeMarker,
  lockQuietHoursAuthority,
  nextQuietHoursMarker,
  readQuietHoursAuthority,
  withQuietHoursMarker,
  type QuietHoursAuthorityRead
} from "./quiet-hours-authority.js";

export interface QuietHoursWritePort {
  upsertWithRevision(
    scopedDb: DataContextDb,
    key: string,
    value: unknown,
    expectedRevision: number | null
  ): Promise<{ revision: number }>;
}

export interface QuietHoursSaveResult {
  readonly effective: QuietHoursSettingsDto;
  readonly changed: boolean;
  readonly before: QuietHoursAuthorityRead;

  /** Revision of the Profile row this save wrote; null when nothing was written. */
  readonly revision: number | null;
}

/** The schedule the Profile screen shows: the canonical one, or Profile's own while unresolved. */
export function displayedQuietHours(read: QuietHoursAuthorityRead): QuietHoursSettingsDto {
  return read.authority.effective ?? normalizeQuietHours(read.profileRow?.value);
}

export function quietHoursAuthorityDto(read: QuietHoursAuthorityRead): QuietHoursAuthorityDto {
  const { status, alertsSchedule } = read.authority;
  return status === "conflict" ? { status, alerts: alertsSchedule } : { status, alerts: null };
}

/**
 * Write expectation over everything the displayed schedule depends on. A canonical Profile is the
 * whole answer; otherwise the nested alert schedule also feeds it, so its content (not its row
 * revision) joins the version and unrelated alert saves never invalidate a Profile edit.
 */
export function quietHoursAuthorityVersion(read: QuietHoursAuthorityRead): string | null {
  const profileVersion = quietHoursVersion(read.profileRow);
  const proactive = read.input.proactive;
  if (read.authority.status === "canonical" || proactive === undefined || proactive === null) {
    return profileVersion;
  }
  const nested = isRecord(proactive) ? proactive.quietHours : proactive;
  if (nested === undefined) return profileVersion;
  const digest = createHash("sha256").update(JSON.stringify(nested)).digest("hex").slice(0, 16);
  return `${profileVersion ?? "none"}|n:${digest}`;
}

/** Locks the owner's quiet-hours inputs and reads them once for the rest of the transaction. */
export async function readQuietHoursForWrite(
  scopedDb: DataContextDb
): Promise<QuietHoursAuthorityRead> {
  await lockQuietHoursAuthority(scopedDb);
  return readQuietHoursAuthority(scopedDb);
}

/**
 * Applies a full schedule to the owner's one quiet-hours record and stamps its migration state.
 * Call after readQuietHoursForWrite in the same transaction.
 */
export async function saveQuietHours(
  scopedDb: DataContextDb,
  repository: QuietHoursWritePort,
  before: QuietHoursAuthorityRead,
  submitted: QuietHoursSettingsDto
): Promise<QuietHoursSaveResult> {
  const profileRow = before.profileRow;

  // A schedule carried from the alert settings is the current value, so only fields the caller
  // actually changes are validated and a legacy equal-time window survives an unrelated edit.
  const carriedFromAlerts = profileRow === null && before.authority.status === "carried";
  const currentRaw = carriedFromAlerts ? before.authority.effective : profileRow?.value;
  const edit = applyQuietHoursEdit(currentRaw, submitted, profileRow !== null || carriedFromAlerts);

  const marker = nextQuietHoursMarker(before.input, edit.next);
  const next = withQuietHoursMarker(edit.next, marker);
  if (profileRow !== null && isDeepStrictEqual(next, profileRow.value)) {
    return { effective: edit.effective, changed: false, before, revision: null };
  }

  const written = await repository.upsertWithRevision(
    scopedDb,
    QUIET_HOURS_PREFERENCE_KEY,
    next,
    profileRow?.revision ?? null
  );
  return { effective: edit.effective, changed: true, before, revision: written.revision };
}

/**
 * Runs before any write of the owner's locale. Locks the quiet-hours inputs and, when the saved
 * pair's meaning depends on the owner zone, freezes today's verdict into Profile so the zone change
 * can neither create nor settle a conflict.
 */
export async function freezeQuietHoursBeforeLocaleWrite(
  scopedDb: DataContextDb,
  repository: QuietHoursWritePort
): Promise<void> {
  const before = await readQuietHoursForWrite(scopedDb);
  const marker = localeFreezeMarker(before.input);
  const row = before.profileRow;
  if (marker === undefined || row === null || !isRecord(row.value)) return;
  await repository.upsertWithRevision(
    scopedDb,
    QUIET_HOURS_PREFERENCE_KEY,
    withQuietHoursMarker(row.value, marker),
    row.revision
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
