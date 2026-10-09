import { describe, expect, it } from "vitest";
import type { MeetingCaptureState } from "@moss/shared";
import {
  captureAcknowledged,
  captureStatusLabel
} from "../../packages/meetings/src/web/capture-presentation.js";

const recovering: MeetingCaptureState = {
  grantId: "grant",
  deviceId: "device",
  deviceName: "Recording Mac",
  generation: 2,
  epoch: 2,
  desired: "recording",
  selection: { mode: "microphone-only", microphone: { deviceId: "mic", sourceId: "mic" } },
  epochStartMs: 1000,
  epochEndMs: null,
  stopCutoffMs: null,
  finalizationDeadline: null,
  expiresAt: "2026-10-08T20:00:00Z",
  serverTime: "2026-10-08T19:00:01Z",
  elapsedMs: 1000,
  inventory: null,
  observed: { generation: 2, phase: "recovering" },
  lastSeenAt: "2026-10-08T19:00:01Z",
  gaps: [],
  gapLimitReached: false
};

describe("capture recovery presentation", () => {
  it("labels interrupted source recovery distinctly without acknowledging live recording", () => {
    expect(captureStatusLabel(recovering, true)).toBe("Recovering audio…");
    expect(captureAcknowledged(recovering)).toBe(false);
  });

  it("does not use an old recovery observation for a newer recording generation", () => {
    expect(captureStatusLabel({ ...recovering, generation: 3 }, true)).toBe("Starting…");
  });

  it("keeps lost connection and actual errors distinct from active recovery", () => {
    expect(captureStatusLabel(recovering, false)).toBe("Capture status unconfirmed");
    expect(
      captureStatusLabel({ ...recovering, observed: { generation: 2, phase: "error" } }, true)
    ).toBe("Capture interrupted");
    expect(
      captureStatusLabel({ ...recovering, observed: { generation: 2, phase: "recording" } }, true)
    ).toBe("Recording");
  });

  it.each([
    ["idle", "Connecting…"],
    ["paused", "Pausing…"],
    ["stopped", "Stopping…"],
    ["revoked", "Recording authorization revoked"]
  ] as const)("lets newer %s intent override a recovery observation", (desired, label) => {
    expect(captureStatusLabel({ ...recovering, desired }, true)).toBe(label);
  });

  it("lets completed finalization override an old recovery observation", () => {
    expect(
      captureStatusLabel({ ...recovering, desired: "stopped", finalization: "complete" }, true)
    ).toBe("Recording authority ended");
  });
});
