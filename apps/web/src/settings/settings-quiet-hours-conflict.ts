import type {
  GetQuietHoursSettingsResponse,
  QuietHoursSettingsDto,
  ResolveQuietHoursConflictRequest
} from "@moss/shared";

import { readError } from "./settings-types.js";
import { isStaleQuietHoursSave } from "./settings-quiet-hours-draft.js";

// Rules for choosing between two differing saved quiet-hours schedules. The server re-checks the
// version and the chosen schedule; these only build the offer and its wording.

export const QUIET_HOURS_STALE_CHOICE_MESSAGE =
  "Quiet hours changed somewhere else, so your choice was not saved. The latest schedules are showing now.";

export interface QuietHoursChoice {
  readonly choice: ResolveQuietHoursConflictRequest["choice"];
  readonly quietHours: QuietHoursSettingsDto;
  readonly label: string;
}

/**
 * One button per differing schedule, Profile's first. Two identical schedules make one button;
 * a conflict whose alert schedule is gone offers only Profile's.
 */
export function quietHoursChoices(
  loaded: GetQuietHoursSettingsResponse
): readonly QuietHoursChoice[] {
  if (loaded.authority.status !== "conflict") return [];
  const profile = loaded.quietHours;
  const alerts = loaded.authority.alerts ? { ...loaded.authority.alerts, timezone: null } : null;
  const bothOff = !profile.enabled && alerts !== null && !alerts.enabled;
  const choices: QuietHoursChoice[] = [
    { choice: "profile", quietHours: profile, label: choiceLabel(profile, "Keep", bothOff) }
  ];
  if (alerts && !sameSchedule(profile, alerts)) {
    choices.push({
      choice: "alerts",
      quietHours: alerts,
      label: choiceLabel(alerts, bothOff ? "Keep" : "Turn", bothOff)
    });
  }
  return choices;
}

export function quietHoursChoiceRequest(
  chosen: QuietHoursChoice,
  version: string | null
): ResolveQuietHoursConflictRequest {
  return { choice: chosen.choice, quietHours: chosen.quietHours, expectedVersion: version };
}

export function quietHoursChosenLine(chosen: QuietHoursChoice): string {
  const summary = scheduleSummary(chosen.quietHours);
  return chosen.choice === "profile"
    ? `Kept your saved quiet hours: ${summary}.`
    : `Using your saved email alert schedule: ${summary}.`;
}

export function quietHoursChoiceFailure(error: unknown): string {
  if (isStaleQuietHoursSave(error)) return QUIET_HOURS_STALE_CHOICE_MESSAGE;
  const reason = readError(error).replace(/[.\s]+$/, "");
  return `Your choice could not save: ${reason}. Your previous schedules still apply.`;
}

function choiceLabel(schedule: QuietHoursSettingsDto, offVerb: string, bothOff: boolean): string {
  if (schedule.enabled) {
    const zone = schedule.timezone ? ` (${schedule.timezone})` : "";
    return `Use ${schedule.start} to ${schedule.end}${zone}`;
  }

  // Both sides off differ only in the window each keeps for later, so the label names it.
  return bothOff
    ? `${offVerb} quiet hours off (${schedule.start} to ${schedule.end} when on)`
    : `${offVerb} quiet hours off`;
}

function scheduleSummary(schedule: QuietHoursSettingsDto): string {
  if (!schedule.enabled) return "off";
  const zone = schedule.timezone ? `, ${schedule.timezone} time` : "";
  return `${schedule.start} to ${schedule.end}${zone}`;
}

function sameSchedule(a: QuietHoursSettingsDto, b: QuietHoursSettingsDto): boolean {
  return (
    a.enabled === b.enabled && a.start === b.start && a.end === b.end && a.timezone === b.timezone
  );
}
