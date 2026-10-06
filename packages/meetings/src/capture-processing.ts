import type { MeetingCaptureProcessingFailure } from "@moss/shared";
import { MeetingCaptureError } from "./capture-domain.js";
/** This error carries only a finite, reviewed reason; never provider bodies or transcript text. */
export class CaptureProcessingError extends Error {
  constructor(readonly failure: MeetingCaptureProcessingFailure) {
    super(failure.code);
  }
}
export function captureProcessingFailure(
  error: unknown,
  stage: "dispatch" | "validation" | "persistence",
  describe?: (error: unknown) => MeetingCaptureProcessingFailure | null
): MeetingCaptureProcessingFailure {
  if (error instanceof CaptureProcessingError) return error.failure;
  const known = describe?.(error);
  if (known) return known;
  if (error instanceof MeetingCaptureError)
    return {
      code: error.code,
      reason:
        error.code === "meeting_capture_interrupted" ? "capture-interrupted" : "authority-changed",
      stage: "authorization",
      retryable: false
    };
  return {
    code: "meeting_capture_processing_failed",
    reason: stage === "persistence" ? "transcript-persistence" : "unknown",
    stage,
    retryable: stage === "persistence",
    ...(stage === "persistence" ? { retryAfterMs: 1000 } : {})
  };
}
