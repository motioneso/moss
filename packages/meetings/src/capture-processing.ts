import type { MeetingCaptureProcessingFailure } from "@moss/shared";
import { MeetingCaptureError } from "./capture-domain.js";
/** This error carries only a finite, reviewed reason; never provider bodies or transcript text. */
export class CaptureProcessingError extends Error {
  constructor(readonly failure: MeetingCaptureProcessingFailure) {
    super(failure.code);
  }
}
/** Provider timestamp rounding can extend a clip end by at most 100ms. Keep all persisted
 * evidence inside the admitted clip; never repair starts, reversed intervals or invalid data. */
export function normalizeCaptureSegments(
  segments: readonly { startMs: number; endMs: number; text: string }[],
  durationMs: number
) {
  let characters = 0;
  return segments.map((segment) => {
    if (typeof segment.text === "string") characters += segment.text.length;
    if (
      !Number.isSafeInteger(segment.startMs) ||
      !Number.isSafeInteger(segment.endMs) ||
      segment.startMs < 0 ||
      segment.startMs >= durationMs ||
      segment.endMs <= segment.startMs ||
      segment.endMs - durationMs > 100 ||
      typeof segment.text !== "string" ||
      segment.text.includes("\0") ||
      characters > 64000
    )
      throw new CaptureProcessingError({
        code: "meeting_capture_processing_failed",
        reason: "timestamp-or-content-invalid",
        stage: "validation",
        retryable: false
      });
    return { ...segment, endMs: Math.min(segment.endMs, durationMs) };
  });
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
