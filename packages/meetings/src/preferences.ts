import { MeetingRecordingNoticeRepository } from "./recording-notice.js";
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
export const MEETING_SETUP_KEY = "meetings.setup-completed-at";
export type MeetingPreferenceStore = Pick<PreferencesRepository, "get" | "upsert">;
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
export class MeetingPreferencesRepository {
  constructor(
    private readonly store: MeetingPreferenceStore = new PreferencesRepository(),
    private readonly notices = new MeetingRecordingNoticeRepository()
  ) {}
  async get(db: DataContextDb): Promise<MeetingCapturePreferences> {
    const [mode, source, summarize, template, completed] = await Promise.all(
      [
        MEETING_CAPTURE_DEFAULT_KEY,
        MEETING_CAPTURE_SOURCE_KEY,
        MEETING_SUMMARIZE_KEY,
        MEETING_TEMPLATE_KEY,
        MEETING_SETUP_KEY
      ].map((key) => this.store.get(db, key))
    );
    return {
      defaultCaptureMode: parseMeetingCaptureMode(mode),
      rememberedSource: parseMeetingRememberedSource(source),
      summarizeOnStop: typeof summarize === "boolean" ? summarize : true,
      summaryTemplateId:
        typeof template === "string"
          ? (getMeetingOutputTemplate(template, 1)?.id ?? "general")
          : "general",
      setupCompletedAt: timestamp(completed)
    };
  }
  async update(
    db: DataContextDb,
    input: UpdateMeetingCapturePreferences,
    at = new Date()
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
          : input.defaultCaptureMode,
      summarizeOnStop: input.summarizeOnStop ?? current.summarizeOnStop,
      summaryTemplateId: input.summaryTemplateId ?? current.summaryTemplateId,
      setupCompletedAt: input.completeSetup ? at.toISOString() : current.setupCompletedAt
    };
    if (input.completeSetup) {
      await this.notices.requireCurrent(db);
      if (!source || source.mode !== next.defaultCaptureMode)
        throw new MeetingCaptureError("meeting_capture_setup_required", 409);
    }
    const writes: [string, unknown][] = [];
    if (input.defaultCaptureMode !== undefined)
      writes.push([MEETING_CAPTURE_DEFAULT_KEY, next.defaultCaptureMode]);
    if (input.rememberedSource !== undefined) writes.push([MEETING_CAPTURE_SOURCE_KEY, source]);
    if (input.summarizeOnStop !== undefined)
      writes.push([MEETING_SUMMARIZE_KEY, next.summarizeOnStop]);
    if (input.summaryTemplateId !== undefined)
      writes.push([MEETING_TEMPLATE_KEY, next.summaryTemplateId]);
    if (input.completeSetup) writes.push([MEETING_SETUP_KEY, next.setupCompletedAt]);
    for (const [key, value] of writes) await this.store.upsert(db, key, value);
    return next;
  }
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
