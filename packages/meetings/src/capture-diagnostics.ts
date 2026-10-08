import type { MeetingCaptureAudioInput, MeetingCaptureAudioReceipt } from "@moss/shared";
const stages = new Set([
  "configuration",
  "dispatch",
  "response",
  "validation",
  "persistence",
  "authorization"
]);
const reasons = new Set([
  "configuration-unavailable",
  "route-changed",
  "cancelled",
  "provider-timeout",
  "provider-rate-limited",
  "provider-authentication",
  "provider-unavailable",
  "provider-network",
  "provider-response-invalid",
  "invalid-audio",
  "unknown",
  "transcript-persistence",
  "transcript-conflict",
  "timestamp-or-content-invalid",
  "capture-interrupted",
  "authority-changed",
  "audio-expired"
]);
/** A fixed metadata allow-list; raw errors, provider responses and source content never enter this object. */
export function captureAudioDiagnostic(
  input: MeetingCaptureAudioInput,
  receipt: MeetingCaptureAudioReceipt
): Record<string, unknown> | null {
  if (receipt.status !== "failed" || receipt.replayed) return null;
  return {
    event: "meeting_capture_processing_outcome",
    status: receipt.retryable ? "deferred" : "failed",
    stage: receipt.stage && stages.has(receipt.stage) ? receipt.stage : "dispatch",
    reason: receipt.reason && reasons.has(receipt.reason) ? receipt.reason : "unknown",
    retryable: receipt.retryable === true,
    ...(typeof receipt.httpStatus === "number" &&
    Number.isInteger(receipt.httpStatus) &&
    receipt.httpStatus >= 100 &&
    receipt.httpStatus <= 599
      ? { httpStatus: receipt.httpStatus }
      : {}),
    ...(Number.isSafeInteger(input.sequence) && input.sequence >= 0
      ? { sequence: input.sequence }
      : {}),
    ...(Number.isSafeInteger(input.epoch) && input.epoch > 0 && input.epoch <= 64
      ? { epoch: input.epoch }
      : {}),
    ...(Number.isSafeInteger(input.endMs - input.startMs) &&
    input.endMs > input.startMs &&
    input.endMs - input.startMs <= 10000
      ? { durationMs: input.endMs - input.startMs }
      : {}),
    ...(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestKey)
      ? { requestKey: input.requestKey }
      : {})
  };
}
