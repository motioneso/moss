import type { GenerateMeetingOutputInput } from "./meeting-output-api.js";
import type { MeetingCaptureSelection } from "./meeting-api.js";

export type MeetingCaptureMode = MeetingCaptureSelection["mode"];
export interface MeetingRememberedSource {
  readonly deviceId: string;
  readonly microphoneId: string;
  readonly applicationId?: string;
  readonly mode: MeetingCaptureMode;
}
export interface MeetingCapturePreferences {
  readonly rememberedSource: MeetingRememberedSource | null;
  readonly defaultCaptureMode: MeetingCaptureMode | null;
  readonly summarizeOnStop: boolean;
  readonly summaryTemplateId: GenerateMeetingOutputInput["templateId"];
  readonly setupCompletedAt: string | null;
}
export interface UpdateMeetingCapturePreferences {
  readonly rememberedSource?: MeetingRememberedSource | null;
  readonly defaultCaptureMode?: MeetingCaptureMode | null;
  readonly summarizeOnStop?: boolean;
  readonly summaryTemplateId?: GenerateMeetingOutputInput["templateId"];
  readonly completeSetup?: true;
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
    ...preferenceProperties,
    completeSetup: { const: true }
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
    "setupCompletedAt"
  ],
  properties: {
    ...preferenceProperties,
    setupCompletedAt: { type: "string", format: "date-time", nullable: true }
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
