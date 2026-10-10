import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { localDay, moodIndex } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { resolveEffectiveWellnessConsent, wellnessConsentRequiredResult } from "./ai-consent.js";
import { medicationLogBelongsToDate, WellnessRepository } from "./repository.js";
import { computeSchedule } from "./schedule.js";
import { serializeCheckin } from "./serialize.js";

const repository = new WellnessRepository();
const preferences = new PreferencesRepository();

export const wellnessRecentCheckInsExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  if (!(await resolveEffectiveWellnessConsent(scopedDb, preferences, services, true))) {
    return wellnessConsentRequiredResult();
  }
  const checkins = await repository.listCheckins(scopedDb, { limit: 20 });
  return {
    data: {
      items: checkins.map((c) => {
        const dto = serializeCheckin(c);
        return {
          checkedInAt: dto.checkedInAt,
          feelingCore: dto.feelingCore,
          feelingSecondary: dto.feelingSecondary,
          intensity: dto.intensity,
          moodIndex: dto.intensity != null ? moodIndex(dto.feelingCore, dto.intensity) : null,
          note: dto.note
        };
      })
    },
    columnOrder: [
      "checkedInAt",
      "feelingCore",
      "feelingSecondary",
      "intensity",
      "moodIndex",
      "note"
    ]
  };
};

const ADHERENCE_WINDOW_DAYS = 7;

export const wellnessMedicationAdherenceExecute: ToolExecute = async (
  scopedDb,
  _input,
  ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  if (!(await resolveEffectiveWellnessConsent(scopedDb, preferences, services, true))) {
    return wellnessConsentRequiredResult();
  }
  // Counts/status only — never a full medication list (privacy posture).
  const timeZone = ctx.localTimezone ?? "UTC";
  const [logs, meds] = await Promise.all([
    repository.listRecentLogs(scopedDb, { sinceDays: ADHERENCE_WINDOW_DAYS }),
    repository.listMedications(scopedDb)
  ]);
  const taken = logs.filter((l) => l.status === "taken").length;
  const skipped = logs.filter((l) => l.status === "skipped").length;
  const prn = logs.filter((l) => l.status === "prn").length;
  // Expected slots, not just logged rows, so unlogged doses count against adherence (same
  // denominator the insights route and export use).
  const today = localDay(new Date(), timeZone);
  const [year, month, dayOfMonth] = today.split("-").map(Number);
  let expected = 0;
  for (let i = 0; i < ADHERENCE_WINDOW_DAYS; i++) {
    const day = new Date(Date.UTC(year!, month! - 1, dayOfMonth! - i));
    const dayLogs = logs.filter((log) => medicationLogBelongsToDate(log, day, timeZone));
    expected += computeSchedule(meds, dayLogs, day).filter((slot) => !slot.asNeeded).length;
  }
  const scheduled = Math.max(expected, taken + skipped);
  return {
    data: {
      windowDays: ADHERENCE_WINDOW_DAYS,
      scheduled,
      taken,
      skipped,
      prn,
      adherenceRate: scheduled > 0 ? Math.round((taken / scheduled) * 100) / 100 : null
    }
  };
};
