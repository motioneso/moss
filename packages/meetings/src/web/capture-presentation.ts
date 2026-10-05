import type {
  MeetingCaptureInventory,
  MeetingCaptureSelection,
  MeetingCaptureState
} from "@moss/shared";
import type { CaptureMode } from "./capture-modes.js";

export interface CaptureChoice {
  readonly mode: CaptureMode | null;
  readonly microphoneId: string;
  readonly applicationId: string;
  readonly notice: boolean;
}
export const emptyCaptureChoice: CaptureChoice = {
  mode: null,
  microphoneId: "",
  applicationId: "",
  notice: false
};
export function captureConnected(capture: MeetingCaptureState, now = Date.now()): boolean {
  return (
    capture.lastSeenAt !== null &&
    now - Date.parse(capture.lastSeenAt) <= 10000 &&
    Date.parse(capture.expiresAt) > now
  );
}
export function captureAcknowledged(capture: MeetingCaptureState): boolean {
  return (
    capture.observed?.generation === capture.generation &&
    capture.observed.phase === capture.desired
  );
}
export function captureStatusLabel(capture: MeetingCaptureState, connected: boolean): string {
  if (capture.desired === "revoked") return "Authorization revoked";
  if (capture.desired === "stopped" && captureAcknowledged(capture)) return "Stopped";
  if (!connected) return "Capture status unconfirmed";
  if (capture.observed?.phase === "error") return "Capture interrupted";
  if (captureAcknowledged(capture)) {
    return { idle: "Connected", recording: "Recording", paused: "Paused", stopped: "Stopped" }[
      capture.desired
    ];
  }
  return { idle: "Connecting…", recording: "Starting…", paused: "Pausing…", stopped: "Stopping…" }[
    capture.desired
  ];
}
export function captureSelection(
  choice: CaptureChoice,
  inventory: MeetingCaptureInventory | null
): MeetingCaptureSelection | null {
  const microphone = inventory?.microphones.find((item) => item.deviceId === choice.microphoneId);
  if (!microphone || !choice.mode || inventory?.microphonePermission !== "granted") return null;
  const input = { microphone: { deviceId: microphone.deviceId, sourceId: microphone.sourceId } };
  if (choice.mode === "microphone-only") return { ...input, mode: choice.mode };
  if (inventory.systemAudioPermission === "denied") return null;
  if (choice.mode === "selected-app") {
    const application = inventory.applications.find(
      (item) => item.appProcessTreeId === choice.applicationId
    );
    return application
      ? {
          ...input,
          mode: choice.mode,
          outputSourceId: "output",
          appProcessTreeId: application.appProcessTreeId
        }
      : null;
  }
  return inventory.computerAudio.available
    ? {
        ...input,
        mode: choice.mode,
        outputSourceId: "output",
        scope: {
          kind: "process-exclusion",
          excludedProcessTreeIds: inventory.computerAudio.excludedProcessTreeIds
        }
      }
    : null;
}
