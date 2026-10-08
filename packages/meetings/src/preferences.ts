import type { DataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import {
  parseMeetingCaptureMode,
  parseMeetingRememberedSource,
  type MeetingCapturePreferences,
  type MeetingCaptureInventory,
  type MeetingCaptureSelection,
  type MeetingRememberedSource,
  type UpdateMeetingCapturePreferences
} from "@moss/shared";
import { MeetingCaptureError, validateCaptureSelection } from "./capture-domain.js";
import { getMeetingOutputTemplate } from "./output-validation.js";

export const MEETING_CAPTURE_DEFAULT_KEY = "meetings.capture.default-mode";
export const MEETING_CAPTURE_SOURCE_KEY = "meetings.capture.remembered-source";
export const MEETING_SUMMARIZE_KEY = "meetings.summarize-on-stop";
export const MEETING_TEMPLATE_KEY = "meetings.summary-template";
export type MeetingPreferenceStore = Pick<PreferencesRepository, "get" | "upsert">;
export class MeetingPreferencesRepository {
  constructor(private readonly store: MeetingPreferenceStore = new PreferencesRepository()) {}
  /** Distinguish a saved default from get()’s fallback through the remembered source. */
  async getPersistedDefaultCaptureMode(db: DataContextDb) {
    return parseMeetingCaptureMode(await this.store.get(db, MEETING_CAPTURE_DEFAULT_KEY));
  }
  async get(db: DataContextDb): Promise<MeetingCapturePreferences> {
    const [mode, source, summarize, template] = await Promise.all(
      [
        MEETING_CAPTURE_DEFAULT_KEY,
        MEETING_CAPTURE_SOURCE_KEY,
        MEETING_SUMMARIZE_KEY,
        MEETING_TEMPLATE_KEY
      ].map((key) => this.store.get(db, key))
    );
    const rememberedSource = parseMeetingRememberedSource(source);
    return {
      defaultCaptureMode:
        parseMeetingCaptureMode(mode) ?? rememberedSource?.mode ?? "computer-audio",
      rememberedSource,
      summarizeOnStop: typeof summarize === "boolean" ? summarize : true,
      summaryTemplateId:
        typeof template === "string"
          ? (getMeetingOutputTemplate(template, 1)?.id ?? "general")
          : "general"
    };
  }
  async update(
    db: DataContextDb,
    input: UpdateMeetingCapturePreferences
  ): Promise<MeetingCapturePreferences> {
    const current = await this.get(db);
    const source =
      input.rememberedSource === undefined
        ? current.rememberedSource
        : parseMeetingRememberedSource(input.rememberedSource);
    if (
      (input.rememberedSource != null && !source) ||
      (input.summaryTemplateId !== undefined &&
        !getMeetingOutputTemplate(input.summaryTemplateId, 1))
    )
      throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
    const next: MeetingCapturePreferences = {
      ...current,
      rememberedSource: source,
      defaultCaptureMode:
        input.defaultCaptureMode === undefined
          ? current.defaultCaptureMode
          : (input.defaultCaptureMode ?? source?.mode ?? "computer-audio"),
      summarizeOnStop: input.summarizeOnStop ?? current.summarizeOnStop,
      summaryTemplateId: input.summaryTemplateId ?? current.summaryTemplateId
    };
    const writes: [string, unknown][] = [];
    if (input.defaultCaptureMode !== undefined)
      writes.push([MEETING_CAPTURE_DEFAULT_KEY, next.defaultCaptureMode]);
    if (input.rememberedSource !== undefined) writes.push([MEETING_CAPTURE_SOURCE_KEY, source]);
    if (input.summarizeOnStop !== undefined)
      writes.push([MEETING_SUMMARIZE_KEY, next.summarizeOnStop]);
    if (input.summaryTemplateId !== undefined)
      writes.push([MEETING_TEMPLATE_KEY, next.summaryTemplateId]);
    for (const [key, value] of writes) await this.store.upsert(db, key, value);
    return next;
  }
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
