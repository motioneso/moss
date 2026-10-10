import type {
  MeetingCaptureInventory,
  MeetingCaptureMode,
  MeetingCaptureSelection,
  MeetingCaptureState
} from "@moss/shared";

export interface CaptureChoice {
  readonly mode: MeetingCaptureMode | null;
  readonly microphoneId: string;
  readonly applicationId: string;
}
export const emptyCaptureChoice: CaptureChoice = {
  mode: null,
  microphoneId: "",
  applicationId: ""
};
export function choiceFromCapture(capture: MeetingCaptureState | null | undefined): CaptureChoice {
  const selection = capture?.selection;
  return selection
    ? {
        mode: selection.mode,
        microphoneId: selection.microphone?.deviceId ?? "",
        applicationId: selection.mode === "selected-app" ? (selection.applicationId ?? "") : ""
      }
    : emptyCaptureChoice;
}
export function captureConnected(capture: MeetingCaptureState, now = Date.now()): boolean {
  return (
    capture.lastSeenAt !== null &&
    now - Date.parse(capture.lastSeenAt) <= (capture.leaseMs ?? 30000) &&
    Date.parse(capture.expiresAt) > now
  );
}
export function captureAcknowledged(capture: MeetingCaptureState): boolean {
  return (
    capture.observed?.generation === capture.generation &&
    capture.observed.phase === capture.desired
  );
}
export function captureStopped(capture: MeetingCaptureState | null | undefined): boolean {
  return (
    !!capture &&
    capture.desired === "stopped" &&
    (captureAcknowledged(capture) || capture.finalization === "complete")
  );
}
export function captureStatusLabel(capture: MeetingCaptureState, connected: boolean): string {
  if (capture.desired === "revoked") return captureRevocationLabel(capture);
  if (capture.desired === "stopped" && captureAcknowledged(capture)) return "Stopped";
  if (capture.desired === "stopped" && capture.finalization === "complete")
    return "Recording authority ended";
  if (!connected) return "Capture status unconfirmed";
  if (capture.observed?.phase === "error") return "Capture interrupted";
  if (
    capture.desired === "recording" &&
    capture.observed?.phase === "recovering" &&
    capture.observed.generation === capture.generation
  )
    return "Recovering audio…";
  if (captureAcknowledged(capture)) {
    return { idle: "Connected", recording: "Recording", paused: "Paused", stopped: "Stopped" }[
      capture.desired
    ];
  }
  return { idle: "Connecting…", recording: "Starting…", paused: "Pausing…", stopped: "Stopping…" }[
    capture.desired
  ];
}
export function captureRevocationLabel(capture: MeetingCaptureState): string {
  switch (capture.revocationReason) {
    case "device-unavailable":
      return "Mac unlinked or device access expired";
    case "recording-permission-revoked":
      return "Recording permission revoked";
    case "session-ended":
      return "Recording browser session ended";
    case "connection-replaced":
      return "Mac recording connection replaced";
    case "expired":
      return "Recording session expired";
    default:
      return "Recording authorization revoked";
  }
}
export function captureSelection(
  choice: CaptureChoice,
  inventory: MeetingCaptureInventory | null
): MeetingCaptureSelection | null {
  const microphones = inventory?.microphones.filter(
    (item) => item.deviceId === choice.microphoneId
  );
  const microphone = microphones?.length === 1 ? microphones[0] : undefined;
  if (!inventory || !microphone || !choice.mode || inventory.microphonePermission === "denied")
    return null;
  const input = { microphone: { deviceId: microphone.deviceId, sourceId: microphone.sourceId } };
  if (choice.mode === "microphone-only") return { ...input, mode: choice.mode };
  if (inventory.systemAudioPermission === "denied") return null;
  if (choice.mode === "selected-app") {
    const applications = inventory.applications.filter(
      (item) => item.applicationId === choice.applicationId
    );
    const application = applications.length === 1 ? applications[0] : undefined;
    return application
      ? {
          ...input,
          mode: choice.mode,
          outputSourceId: "output",
          appProcessTreeId: application.appProcessTreeId,
          ...(application.applicationId ? { applicationId: application.applicationId } : {})
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
