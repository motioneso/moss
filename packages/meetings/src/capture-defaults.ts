import type { DataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import {
  parseMeetingCaptureMode,
  parseMeetingRememberedSource,
  type MeetingCapturePreferences,
  type MeetingCaptureInventory,
  type MeetingCaptureSelection,
  type MeetingRememberedSource
} from "@moss/shared";
import { MeetingCaptureError, validateCaptureSelection } from "./capture-domain.js";

export const MEETING_CAPTURE_DEFAULT_KEY = "meetings.capture.default-mode";
export const MEETING_CAPTURE_SOURCE_KEY = "meetings.capture.remembered-source";
export async function readMeetingCapturePreferences(
  db: DataContextDb,
  store: Pick<PreferencesRepository, "get"> = new PreferencesRepository()
): Promise<MeetingCapturePreferences> {
  const [mode, source] = await Promise.all([
    store.get(db, MEETING_CAPTURE_DEFAULT_KEY),
    store.get(db, MEETING_CAPTURE_SOURCE_KEY)
  ]);
  const rememberedSource = parseMeetingRememberedSource(source);
  return {
    defaultCaptureMode: parseMeetingCaptureMode(mode) ?? rememberedSource?.mode ?? "computer-audio",
    ...(rememberedSource ? { rememberedSource } : {})
  };
}
/** Resolve defaults without persisting hardware choices or broadening a saved exact source. */
export function resolveCaptureSource(
  preferences: MeetingCapturePreferences,
  deviceId: string,
  inventory: MeetingCaptureInventory
): MeetingRememberedSource {
  const remembered = preferences.rememberedSource;
  if (remembered && remembered.deviceId !== deviceId)
    throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
  const mode = preferences.defaultCaptureMode ?? remembered?.mode ?? "computer-audio";
  if (remembered) return { ...remembered, mode };
  const defaults =
    inventory.defaultMicrophoneId === undefined
      ? inventory.microphones
      : inventory.microphones.filter((mic) => mic.deviceId === inventory.defaultMicrophoneId);
  if (defaults.length !== 1 || mode === "selected-app")
    throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
  return { deviceId, microphoneId: defaults[0]!.deviceId, mode };
}
export function savedCaptureSelection(
  source: MeetingRememberedSource,
  inventory: MeetingCaptureInventory
): MeetingCaptureSelection {
  const matchingMicrophones = inventory.microphones.filter(
    (item) => item.deviceId === source.microphoneId
  );
  const match = matchingMicrophones.length === 1 ? matchingMicrophones[0] : undefined;
  const microphone = match ? { deviceId: match.deviceId, sourceId: match.sourceId } : null;
  if (!microphone) throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
  let selection: MeetingCaptureSelection;
  if (source.mode === "microphone-only") selection = { mode: source.mode, microphone };
  else if (source.mode === "computer-audio")
    selection = {
      mode: source.mode,
      microphone,
      outputSourceId: "output",
      scope: {
        kind: "process-exclusion",
        excludedProcessTreeIds: inventory.computerAudio.excludedProcessTreeIds
      }
    };
  else {
    const applications = inventory.applications.filter(
      (item) => item.applicationId === source.applicationId
    );
    const application = applications.length === 1 ? applications[0] : undefined;
    if (!application) throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
    selection = {
      mode: source.mode,
      microphone,
      outputSourceId: "output",
      appProcessTreeId: application.appProcessTreeId,
      applicationId: source.applicationId
    };
  }
  try {
    validateCaptureSelection(selection, inventory);
  } catch {
    throw new MeetingCaptureError("meeting_capture_source_unavailable", 409);
  }
  return selection;
}
