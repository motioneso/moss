import type { DataContextDb } from "@moss/db";
import { deferUntilQuietHoursEnd } from "@moss/module-sdk";
import type { ProactiveMonitoringPreferenceV1, ProactiveSource } from "@moss/shared";

import type { CardRepository } from "./card-repository.js";
import { resolveSourcePreference } from "./preferences-repository.js";
import type { ProactiveQuietPolicy } from "./types.js";

export type AntiSpamVerdict =
  | { readonly allow: true; readonly deferredUntil: string | null }
  | { readonly allow: false; readonly reason: string };

export class AntiSpamPolicy {
  constructor(private readonly cardRepository: CardRepository) {}

  async check(
    scopedDb: DataContextDb,
    ownerUserId: string,
    source: ProactiveSource,
    stableKey: string,
    pref: ProactiveMonitoringPreferenceV1,
    nowIso: string,
    timeZone: string,
    quiet?: ProactiveQuietPolicy | null
  ): Promise<AntiSpamVerdict> {
    // Dismissed stable key: suppress for 30 days.
    const dismissed = await this.cardRepository.isDismissedStableKeySuppressed(
      scopedDb,
      ownerUserId,
      source,
      stableKey
    );
    if (dismissed) {
      return { allow: false, reason: "dismissed_stable_key_suppressed" };
    }

    const localDayStart = localMidnight(nowIso, timeZone);
    const counts = await this.cardRepository.getActiveCounts(
      scopedDb,
      ownerUserId,
      source,
      nowIso,
      localDayStart
    );

    // Effective source daily cap (may be reduced by too_much feedback — handled by scanner).
    const sourcePref = resolveSourcePreference(pref, source);

    // Global daily cap.
    if (counts.totalToday >= pref.dailyCardCap) {
      return { allow: false, reason: "global_daily_cap" };
    }
    // Per-source daily cap.
    if (counts.sourceToday >= sourcePref.dailyCardCap) {
      return { allow: false, reason: "source_daily_cap" };
    }
    // Per-source hourly cap.
    if (counts.sourceLastHour >= 1) {
      return { allow: false, reason: "source_hourly_cap" };
    }

    // Quiet hours deferral. The saved schedule, when one governs, replaces the nested one.
    const quietHours = quiet ?? { ...pref.quietHours, timeZone };
    if (quietHours.enabled) {
      const deferredUntil = quietHoursDeferral(nowIso, quietHours.timeZone, quietHours);
      if (deferredUntil) {
        return { allow: true, deferredUntil };
      }
    }

    return { allow: true, deferredUntil: null };
  }
}

function localMidnight(nowIso: string, timeZone: string): string {
  try {
    return wallTimeToInstant(
      localDateString(new Date(nowIso), timeZone),
      "00:00",
      timeZone
    ).toISOString();
  } catch {
    const d = new Date(nowIso);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
}

function quietHoursDeferral(
  nowIso: string,
  timeZone: string,
  qh: { readonly startLocalTime: string; readonly endLocalTime: string }
): string | null {
  try {
    return (
      deferUntilQuietHoursEnd(
        new Date(nowIso),
        qh.startLocalTime,
        qh.endLocalTime,
        timeZone
      )?.toISOString() ?? null
    );
  } catch {
    return null;
  }
}

function localDateString(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone });
}

// Converts a wall-clock date and time in `timeZone` to the instant it names.
// Never reads the host zone: all arithmetic is in UTC.
function wallTimeToInstant(localDateStr: string, localTimeStr: string, timeZone: string): Date {
  const [y = 1970, mo = 1, d = 1] = localDateStr.split("-").map(Number);
  const [h = 0, mi = 0] = localTimeStr.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the offset when the guess lands across a DST change.
  let instant = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

// Offset of `timeZone` from UTC, in milliseconds, at the given instant.
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}
