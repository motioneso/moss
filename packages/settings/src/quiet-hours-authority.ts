import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { parseProactiveMonitoringPreference } from "@moss/proactive-monitoring";
import { PROACTIVE_MONITORING_PREFERENCE_KEY, type QuietHoursSettingsDto } from "@moss/shared";

import {
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_PREFERENCE_KEY,
  isStrictLocalTime,
  isValidTimeZone
} from "./quiet-hours-application.js";

const LOCALE_PREFERENCE_KEY = "locale";

/**
 * Migration state stored on the Profile row. "canonical" means Profile governs every consumer;
 * "unresolved" freezes a conflict between Profile and the older nested alert schedule.
 */
export const QUIET_HOURS_AUTHORITY_FIELD = "authority";
export type QuietHoursMarker = "canonical" | "unresolved";

export type QuietHoursAuthorityStatus =
  | "default"
  | "carried"
  | "canonical"
  | "conflict"
  | "malformed";

export interface QuietHoursAuthorityInput {
  readonly profile: unknown;
  readonly proactive: unknown;
  readonly locale: unknown;
}

export interface QuietHoursWindow {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

export interface QuietHoursAuthority {
  readonly status: QuietHoursAuthorityStatus;

  /** The one schedule every consumer follows; null while unresolved or malformed. */
  readonly effective: QuietHoursSettingsDto | null;
  readonly ownerTimeZone: string;
  readonly profileValue: unknown;

  /** The schedule the alert workers keep following when no canonical schedule exists. */
  readonly alertsSchedule: QuietHoursWindow | null;
}

export interface AlertsQuietPolicy {
  readonly enabled: boolean;
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly timeZone: string;
}

type Side =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "present"; readonly schedule: QuietHoursSettingsDto };

export function classifyQuietHours(input: QuietHoursAuthorityInput): QuietHoursAuthority {
  const ownerTimeZone = resolveOwnerTimeZone(input.locale);
  const marker = readMarker(input.profile);
  const profile = readProfile(input.profile);
  const nested = readNested(input.proactive);
  const alertsSchedule =
    nested.kind === "present"
      ? { enabled: nested.schedule.enabled, start: nested.schedule.start, end: nested.schedule.end }
      : null;
  const result = (status: QuietHoursAuthorityStatus, effective: QuietHoursSettingsDto | null) => ({
    status,
    effective,
    ownerTimeZone,
    profileValue: input.profile,
    alertsSchedule
  });

  if (marker === "invalid" || profile.kind === "malformed") return result("malformed", null);
  if (marker === "canonical" && profile.kind === "present") {
    return result("canonical", profile.schedule);
  }
  if (marker === "unresolved") return result("conflict", null);
  if (nested.kind === "malformed") return result("malformed", null);
  if (profile.kind === "absent") {
    return nested.kind === "absent"
      ? result("default", DEFAULT_QUIET_HOURS)
      : result("carried", nested.schedule);
  }
  if (nested.kind === "absent") return result("carried", profile.schedule);
  return sameMeaning(profile.schedule, nested.schedule, ownerTimeZone)
    ? result("carried", profile.schedule)
    : result("conflict", null);
}

/** Profile value for the notifications and focus reader. Null means quiet hours are off. */
export function notificationsQuietHoursValue(authority: QuietHoursAuthority): unknown {
  switch (authority.status) {
    case "default":
      return null;
    case "carried":
    case "canonical":
      return authority.effective;
    default:
      return authority.profileValue ?? null;
  }
}

/** Quiet policy for the alert workers. Null means they keep their own nested schedule. */
export function alertsQuietPolicy(authority: QuietHoursAuthority): AlertsQuietPolicy | null {
  const effective = authority.effective;
  if (effective === null) return null;
  return {
    enabled: effective.enabled,
    startLocalTime: effective.start,
    endLocalTime: effective.end,
    timeZone: effective.timezone ?? authority.ownerTimeZone
  };
}

/**
 * Marker for a Profile write. A write on an unambiguous owner makes Profile canonical, a write on
 * a conflict keeps it unresolved, and a write that repairs a malformed Profile is judged by the
 * state it leaves behind.
 */
export function nextQuietHoursMarker(
  before: QuietHoursAuthorityInput,
  nextProfile: unknown
): QuietHoursMarker | undefined {
  const status = classifyQuietHours(before).status;
  if (status === "conflict") return "unresolved";
  if (status !== "malformed") return "canonical";
  const after = classifyQuietHours({ ...before, profile: withoutMarker(nextProfile) }).status;
  if (after === "default" || after === "carried") return "canonical";
  if (after === "conflict") return "unresolved";
  return undefined;
}

/**
 * Marker a locale write must stamp first. An unmarked pair whose comparison depends on the owner
 * zone is frozen as judged under the old zone, so a zone change can neither create nor resolve a
 * conflict.
 */
export function localeFreezeMarker(before: QuietHoursAuthorityInput): QuietHoursMarker | undefined {
  if (readMarker(before.profile) !== undefined) return undefined;
  const profile = readProfile(before.profile);
  const nested = readNested(before.proactive);
  if (profile.kind !== "present" || nested.kind !== "present") return undefined;
  if (profile.schedule.timezone === null) return undefined;
  const status = classifyQuietHours(before).status;
  if (status === "carried") return "canonical";
  if (status === "conflict") return "unresolved";
  return undefined;
}

/**
 * Value an undo writes back. An unmarked prior row is judged afresh against today's alert schedule
 * and owner zone, and either may have moved while the edit's marker held. So the restored row keeps
 * the verdict the current marker records, unless it reaches that verdict unmarked.
 */
export function undoQuietHoursValue(current: QuietHoursAuthorityInput, previous: unknown): unknown {
  if (!isRecord(previous) || readMarker(previous) !== undefined) return previous;
  const marker = readMarker(current.profile);
  if (marker !== "canonical" && marker !== "unresolved") return previous;
  const restored = classifyQuietHours({ ...current, profile: previous }).status;
  if (restored === "malformed") return previous;
  if (marker === "unresolved") {
    return restored === "conflict" ? previous : withQuietHoursMarker(previous, "unresolved");
  }
  return restored === "conflict" ? withQuietHoursMarker(previous, "canonical") : previous;
}

export function withQuietHoursMarker(
  value: Record<string, unknown>,
  marker: QuietHoursMarker | undefined
): Record<string, unknown> {
  const next = { ...value };
  if (marker === undefined) delete next[QUIET_HOURS_AUTHORITY_FIELD];
  else next[QUIET_HOURS_AUTHORITY_FIELD] = marker;
  return next;
}

export interface QuietHoursAuthorityRead {
  readonly input: QuietHoursAuthorityInput;
  readonly authority: QuietHoursAuthority;
  readonly profileRow: {
    readonly value: unknown;
    readonly revision: number;
    readonly updatedAt: Date;
  } | null;
}

/** One consistent owner-scoped read of the three rows the classification depends on. */
export async function readQuietHoursAuthority(
  scopedDb: DataContextDb
): Promise<QuietHoursAuthorityRead> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.preferences")
    .select(["key", "value_json", "revision", "updated_at"])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("key", "in", [
      QUIET_HOURS_PREFERENCE_KEY,
      PROACTIVE_MONITORING_PREFERENCE_KEY,
      LOCALE_PREFERENCE_KEY
    ])
    .execute();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const profileRow = byKey.get(QUIET_HOURS_PREFERENCE_KEY);
  const input: QuietHoursAuthorityInput = {
    profile: profileRow?.value_json,
    proactive: byKey.get(PROACTIVE_MONITORING_PREFERENCE_KEY)?.value_json,
    locale: byKey.get(LOCALE_PREFERENCE_KEY)?.value_json
  };
  return {
    input,
    authority: classifyQuietHours(input),
    profileRow: profileRow
      ? {
          value: profileRow.value_json,
          revision: profileRow.revision,
          updatedAt: new Date(profileRow.updated_at)
        }
      : null
  };
}

/** The alert workers' quiet policy for the scoped owner. */
export async function resolveAlertsQuietPolicy(
  scopedDb: DataContextDb
): Promise<AlertsQuietPolicy | null> {
  return alertsQuietPolicy((await readQuietHoursAuthority(scopedDb)).authority);
}

/** Serialises every writer of the owner's quiet-hours inputs for the rest of the transaction. */
export async function lockQuietHoursAuthority(scopedDb: DataContextDb): Promise<void> {
  assertDataContextDb(scopedDb);
  await sql`select pg_advisory_xact_lock(hashtext('quiet-hours:' || app.current_actor_user_id()))`.execute(
    scopedDb.db
  );
}

function sameMeaning(
  profile: QuietHoursSettingsDto,
  nested: QuietHoursSettingsDto,
  ownerTimeZone: string
): boolean {
  return (
    profile.enabled === nested.enabled &&
    profile.start === nested.start &&
    profile.end === nested.end &&
    (profile.timezone ?? ownerTimeZone) === ownerTimeZone
  );
}

function readMarker(value: unknown): QuietHoursMarker | "invalid" | undefined {
  if (!isRecord(value) || !(QUIET_HOURS_AUTHORITY_FIELD in value)) return undefined;
  const marker = value[QUIET_HOURS_AUTHORITY_FIELD];
  return marker === "canonical" || marker === "unresolved" ? marker : "invalid";
}

function readProfile(value: unknown): Side {
  if (value === undefined || value === null) return { kind: "absent" };
  if (!isRecord(value)) return { kind: "malformed" };
  const { enabled, start, end, timezone } = value;
  if (typeof enabled !== "boolean" || !isStrictLocalTime(start) || !isStrictLocalTime(end)) {
    return { kind: "malformed" };
  }
  if (timezone === undefined || timezone === null || timezone === "") {
    return { kind: "present", schedule: { enabled, start, end, timezone: null } };
  }
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) return { kind: "malformed" };
  return { kind: "present", schedule: { enabled, start, end, timezone } };
}

function readNested(value: unknown): Side {
  if (value === undefined || value === null) return { kind: "absent" };
  const saved = parseProactiveMonitoringPreference(value);
  if (saved === null) return { kind: "malformed" };
  if (!("quietHours" in saved.raw)) return { kind: "absent" };
  const { enabled, startLocalTime, endLocalTime } = saved.preference.quietHours;
  if (!isStrictLocalTime(startLocalTime) || !isStrictLocalTime(endLocalTime)) {
    return { kind: "malformed" };
  }
  return {
    kind: "present",
    schedule: { enabled, start: startLocalTime, end: endLocalTime, timezone: null }
  };
}

function resolveOwnerTimeZone(locale: unknown): string {
  const timezone = isRecord(locale) ? locale.timezone : undefined;
  return typeof timezone === "string" && timezone.length > 0 && isValidTimeZone(timezone)
    ? timezone
    : "UTC";
}

function withoutMarker(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { [QUIET_HOURS_AUTHORITY_FIELD]: _marker, ...rest } = value;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
