import { describe, expect, it } from "vitest";
import type { MeetingCaptureAudioInput } from "@moss/shared";
import { captureAudioDiagnostic } from "../../packages/meetings/src/capture-diagnostics.js";
const input: MeetingCaptureAudioInput = {
  meetingId: "private-meeting",
  grantId: "private-grant",
  requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceId: "Private device label",
  generation: 1,
  epoch: 1,
  sequence: 2,
  startMs: 0,
  endMs: 1000,
  sampleRateHz: 16000,
  pcmBase64: "private-audio"
};
describe("safe capture processing diagnostics", () => {
  it("reports numeric provider status and finite reasons without source or request content", () => {
    const diagnostic = captureAudioDiagnostic(input, {
      requestKey: input.requestKey,
      status: "failed",
      reason: "provider-unavailable",
      stage: "response",
      retryable: true,
      httpStatus: 503
    });
    expect(diagnostic).toEqual({
      event: "meeting_capture_processing_outcome",
      status: "deferred",
      stage: "response",
      reason: "provider-unavailable",
      retryable: true,
      httpStatus: 503,
      sequence: 2,
      epoch: 1,
      durationMs: 1000,
      requestKey: input.requestKey
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });
  it("never repeats pending/replayed receipts or accepts free-form diagnostic reasons", () => {
    expect(
      captureAudioDiagnostic(input, { requestKey: input.requestKey, status: "pending" })
    ).toBeNull();
    expect(
      captureAudioDiagnostic(input, {
        requestKey: input.requestKey,
        status: "failed",
        replayed: true
      })
    ).toBeNull();
    const result = captureAudioDiagnostic(input, {
      requestKey: input.requestKey,
      status: "failed",
      reason: "secret provider body",
      httpStatus: 999
    });
    expect(result?.reason).toBe("unknown");
    expect(result).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
