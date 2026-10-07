import type { MeetingCaptureSelection } from "./meeting-api.js";

export type MeetingCaptureMode = MeetingCaptureSelection["mode"];
export interface MeetingRememberedSource {
  readonly deviceId: string;
  readonly microphoneId: string;
  readonly applicationId?: string;
  readonly mode: MeetingCaptureMode;
}
export interface MeetingCapturePreferences {
  readonly rememberedSource?: MeetingRememberedSource | null;
  /** null resets to the default microphone and system audio mode. */
  readonly defaultCaptureMode: MeetingCaptureMode | null;
}

export const meetingCapturePreferencesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["defaultCaptureMode"],
  properties: {
    rememberedSource: {
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
    },
    defaultCaptureMode: {
      anyOf: [
        { const: null },
        { type: "string", enum: ["microphone-only", "selected-app", "computer-audio"] }
      ]
    }
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
