import type { MeetingCaptureSelection } from "./meeting-api.js";

export type MeetingCaptureMode = MeetingCaptureSelection["mode"];
export interface MeetingCapturePreferences {
  /** null means the person has never explicitly selected a default, or cleared it. */
  readonly defaultCaptureMode: MeetingCaptureMode | null;
}

export const meetingCapturePreferencesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["defaultCaptureMode"],
  properties: {
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
