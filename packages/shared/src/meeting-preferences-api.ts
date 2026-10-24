import type { GenerateMeetingOutputInput } from "./meeting-output-api.js";
import type { MeetingCaptureSelection } from "./meeting-api.js";
import { MEETING_TRANSCRIPT_LANGUAGES } from "./meeting-transcript-language.js";

export type MeetingCaptureMode = MeetingCaptureSelection["mode"];
export interface MeetingRememberedSource {
  readonly deviceId: string;
  readonly microphoneId: string;
  readonly applicationId?: string;
  readonly mode: MeetingCaptureMode;
}
export interface MeetingCapturePreferences {
  readonly transcriptLanguage: string | null;
  readonly transcriptVocabulary: readonly string[];
  readonly rememberedSource: MeetingRememberedSource | null;
  readonly defaultCaptureMode: MeetingCaptureMode | null;
  readonly summarizeOnStop: boolean;
  readonly summaryTemplateId: GenerateMeetingOutputInput["templateId"];
}
export interface UpdateMeetingCapturePreferences {
  readonly transcriptLanguage?: string | null;
  readonly transcriptVocabulary?: readonly string[];
  readonly rememberedSource?: MeetingRememberedSource | null;
  readonly defaultCaptureMode?: MeetingCaptureMode | null;
  readonly summarizeOnStop?: boolean;
  readonly summaryTemplateId?: GenerateMeetingOutputInput["templateId"];
}
const sourceSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["deviceId", "microphoneId", "mode"],
  properties: {
    deviceId: { type: "string", format: "uuid" },
    microphoneId: { type: "string", minLength: 1, maxLength: 256 },
    applicationId: { type: "string", minLength: 1, maxLength: 256 },
    mode: { type: "string", enum: ["microphone-only", "selected-app", "computer-audio"] }
  }
} as const;
const preferenceProperties = {
  transcriptVocabulary: {
    type: "array",
    maxItems: 100,
    items: { type: "string", maxLength: 1000 }
  },
  transcriptLanguage: {
    anyOf: [{ const: null }, { type: "string", enum: MEETING_TRANSCRIPT_LANGUAGES }]
  },
  rememberedSource: sourceSchema,
  defaultCaptureMode: {
    anyOf: [
      { const: null },
      { type: "string", enum: ["microphone-only", "selected-app", "computer-audio"] }
    ]
  },
  summarizeOnStop: { type: "boolean" },
  summaryTemplateId: {
    type: "string",
    enum: ["general", "one-to-one", "project-review", "interview"]
  }
} as const;
export const updateMeetingCapturePreferencesSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    ...preferenceProperties
  }
} as const;
export const meetingCapturePreferencesSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "rememberedSource",
    "defaultCaptureMode",
    "summarizeOnStop",
    "summaryTemplateId",
    "transcriptLanguage",
    "transcriptVocabulary"
  ],
  properties: {
    ...preferenceProperties
  }
} as const;
export function parseMeetingCaptureMode(value: unknown): MeetingCaptureMode | null {
  return value === "microphone-only" || value === "selected-app" || value === "computer-audio"
    ? value
    : null;
}
export function parseMeetingRememberedSource(value: unknown): MeetingRememberedSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<MeetingRememberedSource>;
  if (
    typeof source.deviceId !== "string" ||
    typeof source.microphoneId !== "string" ||
    !parseMeetingCaptureMode(source.mode) ||
    (source.mode === "selected-app" && typeof source.applicationId !== "string")
  )
    return null;
  return {
    deviceId: source.deviceId,
    microphoneId: source.microphoneId,
    mode: source.mode!,
    ...(source.applicationId ? { applicationId: source.applicationId } : {})
  };
}
