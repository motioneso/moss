import type { DataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";
import {
  parseMeetingCaptureMode,
  normalizeMeetingVocabulary,
  meetingTranscriptionOptions,
  MeetingVocabularyError,
  isMeetingTranscriptLanguage,
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
export const MEETING_TRANSCRIPT_LANGUAGE_KEY = "meetings.transcript-language";
export const MEETING_TRANSCRIPT_VOCABULARY_KEY = "meetings.transcript-vocabulary";
export type MeetingPreferenceStore = Pick<
  PreferencesRepository,
  "get" | "getMany" | "lock" | "upsert"
>;
export class MeetingPreferencesRepository {
  constructor(private readonly store: MeetingPreferenceStore = new PreferencesRepository()) {}
  async getTranscriptionOptions(db: DataContextDb) {
    const current = await this.get(db);
    return meetingTranscriptionOptions(current.transcriptLanguage, current.transcriptVocabulary);
  }
  /** Distinguish a saved default from get()’s fallback through the remembered source. */
  async getPersistedDefaultCaptureMode(db: DataContextDb) {
    return parseMeetingCaptureMode(await this.store.get(db, MEETING_CAPTURE_DEFAULT_KEY));
  }
  async get(db: DataContextDb): Promise<MeetingCapturePreferences> {
    const values = await this.store.getMany(db, [
      MEETING_CAPTURE_DEFAULT_KEY,
      MEETING_CAPTURE_SOURCE_KEY,
      MEETING_SUMMARIZE_KEY,
      MEETING_TEMPLATE_KEY,
      MEETING_TRANSCRIPT_LANGUAGE_KEY,
      MEETING_TRANSCRIPT_VOCABULARY_KEY
    ]);
    const mode = values[MEETING_CAPTURE_DEFAULT_KEY];
    const source = values[MEETING_CAPTURE_SOURCE_KEY];
    const summarize = values[MEETING_SUMMARIZE_KEY];
    const template = values[MEETING_TEMPLATE_KEY];
    const language = values[MEETING_TRANSCRIPT_LANGUAGE_KEY];
    const rememberedSource = parseMeetingRememberedSource(source);
    return {
      transcriptLanguage: isMeetingTranscriptLanguage(language) ? language : null,
      transcriptVocabulary: normalizeMeetingVocabulary(
        values[MEETING_TRANSCRIPT_VOCABULARY_KEY] ?? []
      ),
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
    await this.store.lock(db, "meetings.capture-preferences");
    const current = await this.get(db);
    const source =
      input.rememberedSource === undefined
        ? current.rememberedSource
        : parseMeetingRememberedSource(input.rememberedSource);
    if (
      (input.transcriptLanguage != null &&
        !isMeetingTranscriptLanguage(input.transcriptLanguage)) ||
      (input.rememberedSource != null && !source) ||
      (input.summaryTemplateId !== undefined &&
        !getMeetingOutputTemplate(input.summaryTemplateId, 1))
    )
      throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
    const next: MeetingCapturePreferences = {
      ...current,
      transcriptLanguage:
        input.transcriptLanguage === undefined
          ? current.transcriptLanguage
          : input.transcriptLanguage,
      transcriptVocabulary:
        input.transcriptVocabulary === undefined
          ? current.transcriptVocabulary
          : normalizeVocabularyInput(input.transcriptVocabulary),
      rememberedSource: source,
      defaultCaptureMode:
        input.defaultCaptureMode === undefined
          ? current.defaultCaptureMode
          : (input.defaultCaptureMode ?? source?.mode ?? "computer-audio"),
      summarizeOnStop: input.summarizeOnStop ?? current.summarizeOnStop,
      summaryTemplateId: input.summaryTemplateId ?? current.summaryTemplateId
    };
    try {
      meetingTranscriptionOptions(next.transcriptLanguage, next.transcriptVocabulary);
    } catch (error) {
      if (error instanceof MeetingVocabularyError)
        throw new MeetingCaptureError("meeting_vocabulary_invalid", 400);
      throw error;
    }
    const writes: [string, unknown][] = [];
    if (input.transcriptVocabulary !== undefined)
      writes.push([MEETING_TRANSCRIPT_VOCABULARY_KEY, next.transcriptVocabulary]);
    if (input.transcriptLanguage !== undefined)
      writes.push([MEETING_TRANSCRIPT_LANGUAGE_KEY, next.transcriptLanguage]);
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
function normalizeVocabularyInput(value: unknown) {
  try {
    return normalizeMeetingVocabulary(value);
  } catch (error) {
    if (error instanceof MeetingVocabularyError)
      throw new MeetingCaptureError("meeting_vocabulary_invalid", 400);
    throw error;
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
