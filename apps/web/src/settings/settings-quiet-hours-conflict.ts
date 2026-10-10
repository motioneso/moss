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
    {
      choice: "profile",
      quietHours: profile,
      label: choiceLabel(profile, "Keep", bothOff, zoneCity(profile.timezone))
    }
  ];
  if (alerts && !sameSchedule(profile, alerts)) {
    // Beside a Profile window that names its own zone, say which zone the alert window runs in.
    const alertsZone = profile.enabled && profile.timezone ? "Profile time zone" : null;
    choices.push({
      choice: "alerts",
      quietHours: alerts,
      label: choiceLabel(alerts, bothOff ? "Keep" : "Turn", bothOff, alertsZone)
    });
  }
  return choices;
}

/** One offered schedule has nothing to differ from, so the owner confirms it instead. */
export function quietHoursChoiceNote(choices: readonly QuietHoursChoice[]): string {
  return choices.length > 1
    ? "Your saved quiet hours differ. Choose which schedule to use for future interruptions. Nothing changes until you choose."
    : "Confirm your saved quiet hours to use them for future interruptions. Nothing changes until you confirm.";
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

function choiceLabel(
  schedule: QuietHoursSettingsDto,
  offVerb: string,
  bothOff: boolean,
  zone: string | null
): string {
  if (schedule.enabled) {
    return `Use ${schedule.start} to ${schedule.end}${zone ? ` (${zone})` : ""}`;
  }

  // Both sides off differ only in the window each keeps for later, so the label names it.
  return bothOff
    ? `${offVerb} off (saved ${schedule.start} to ${schedule.end})`
    : `${offVerb} quiet hours off`;
}

/** "America/Argentina/Buenos_Aires" reads as "Buenos Aires", short enough for a phone button. */
function zoneCity(timezone: string | null): string | null {
  if (!timezone) return null;
  return (timezone.split("/").at(-1) ?? timezone).replace(/_/g, " ");
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
