/** Pure rules for the recording panel. A capture is the server's view of one recording. */

export const GAP_REASONS = {
  paused: "Paused",
  expired: "Buffered audio expired",
  "buffer-full": "Audio buffer full",
  "source-unavailable": "Source unavailable",
  "processing-failed": "Transcription failed",
  interrupted: "Capture interrupted",
  discarded: "Audio discarded"
};

export function captureConnected(capture, now = Date.now()) {
  return (
    capture.lastSeenAt !== null &&
    capture.lastSeenAt !== undefined &&
    now - Date.parse(capture.lastSeenAt) <= (capture.leaseMs ?? 30000) &&
    Date.parse(capture.expiresAt) > now
  );
}

export function captureAcknowledged(capture) {
  return (
    capture.observed?.generation === capture.generation &&
    capture.observed.phase === capture.desired
  );
}

export function captureStopped(capture) {
  return (
    !!capture &&
    capture.desired === "stopped" &&
    (captureAcknowledged(capture) || capture.finalization === "complete")
  );
}

export function revocationLabel(capture) {
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

export function statusLabel(capture, connected) {
  if (capture.desired === "revoked") return revocationLabel(capture);
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
  if (captureAcknowledged(capture))
    return { idle: "Connected", recording: "Recording", paused: "Paused", stopped: "Stopped" }[
      capture.desired
    ];
  return { idle: "Connecting…", recording: "Starting…", paused: "Pausing…", stopped: "Stopping…" }[
    capture.desired
  ];
}

/** Milliseconds recorded so far. Only a fresh recording acknowledgement advances between polls. */
export function recordedDuration(capture, serverNow, connected, shown) {
  const acknowledged = capture.recordedDurationMs ?? 0;
  const recording =
    capture.desired === "recording" &&
    captureAcknowledged(capture) &&
    capture.recordedDurationMs !== undefined;
  if (recording && connected && capture.lastSeenAt)
    return acknowledged + Math.max(0, serverNow - Date.parse(capture.lastSeenAt));
  const waiting =
    !captureAcknowledged(capture) && capture.observed?.phase === "recording";
  if ((recording || waiting) && shown?.grantId === capture.grantId)
    return Math.max(acknowledged, shown.duration);
  return acknowledged;
}

/** Whether the saved source choice can start on the linked Mac. */
export function sourceReady(prefs, inventory) {
  if (!inventory || inventory.microphonePermission === "denied") return false;
  const saved = prefs?.rememberedSource;
  const mode = prefs?.defaultCaptureMode ?? saved?.mode ?? "computer-audio";
  const mics = inventory.microphones ?? [];
  const reported = inventory.defaultMicrophoneId;
  const wanted =
    saved?.microphoneId ??
    (typeof reported === "string" ? reported : mics.length === 1 ? mics[0].deviceId : "");
  if (mics.filter((m) => m.deviceId === wanted).length !== 1) return false;
  if (mode === "microphone-only") return true;
  if (inventory.systemAudioPermission === "denied") return false;
  if (mode === "selected-app")
    return (inventory.applications ?? []).filter((a) => a.applicationId === saved?.applicationId)
      .length === 1;
  return inventory.computerAudio?.available === true;
}

/** The hint under the buttons, or null when there is nothing to say. */
export function panelHint(v) {
  if (v.denied) return "Recording access is unavailable. Use Trail Marker’s local Stop, then sign in again.";
  if (v.notFound) return "Recording isn’t available on this server yet.";
  if (v.statusFailed) return "Couldn’t confirm the recorder connection.";
  if (v.revoked && v.capture) return `${revocationLabel(v.capture)}. Recording stopped.`;
  if (v.error) return v.error;
  if (v.capture?.observed?.phase === "error")
    return "Recording was interrupted. Check Trail Marker on your Mac.";
  if (v.processingReady === false) return "Transcription isn’t available. Check AI providers.";
  if (v.capture?.processing?.status === "delayed")
    return "Transcription is delayed. Recording continues.";
  if (v.capture?.finalization === "pending") return "Still being finalised";
  if (v.capture || v.loading || v.ready) return null;
  if (v.devicesFailed) return "Couldn’t confirm the latest Mac connection.";
  if (v.ambiguous)
    return "More than one Mac is connected. Disconnect the extra Mac in Trail Marker.";
  if (v.device?.busy) return "This Mac is recording or finishing another meeting.";
  if (v.device && !v.sourceReady)
    return "The audio source is unavailable. Check microphone and system audio access in Trail Marker, or change Audio source in Settings.";
  if (v.linkedCount) return "Open Trail Marker on your Mac to reconnect.";
  return "Open Trail Marker and follow its linking instructions.";
}

/** Plain message for a failed start or control request. */
export function requestFailure(error) {
  if (error?.code === "meeting_capture_processing_unavailable")
    return "Transcription unavailable. Check Settings → AI providers, then try again.";
  if (error?.status === 429)
    return "The server asked us to wait before retrying. Trail Marker’s local Pause and Stop remain available.";
  if (error?.code === "meeting_capture_busy")
    return "This Mac is still recording or finishing the previous meeting. Stop it and wait for the transcript to finish, then try Start again.";
  if ([400, 409, 413, 422].includes(error?.status))
    return "The connection or audio source changed. Check Trail Marker and try again.";
  return "The command is unconfirmed. Check Trail Marker’s indicator. Stop remains available; retry uses the same request.";
}

/** A definite failure is final. Anything else may still have reached the Mac. */
export const isDefinite = (error) =>
  error?.code === "meeting_capture_processing_unavailable" ||
  [400, 409, 413, 422].includes(error?.status);
