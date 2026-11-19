import test from "node:test";
import assert from "node:assert/strict";
import {
  captureConnected,
  captureStopped,
  isDefinite,
  panelHint,
  recordedDuration,
  requestFailure,
  sourceReady,
  statusLabel
} from "./capture-logic.mjs";

const base = {
  desired: "recording",
  generation: 2,
  observed: { generation: 2, phase: "recording" },
  lastSeenAt: "2026-11-18T10:00:00Z",
  expiresAt: "2026-11-18T12:00:00Z",
  recordedDurationMs: 5000
};
const at = Date.parse("2026-11-18T10:00:10Z");

test("status labels follow the acknowledgement", () => {
  assert.equal(statusLabel(base, true), "Recording");
  assert.equal(statusLabel(base, false), "Capture status unconfirmed");
  assert.equal(
    statusLabel({ ...base, observed: { generation: 1, phase: "idle" } }, true),
    "Starting…"
  );
  assert.equal(
    statusLabel({ ...base, desired: "paused", observed: { generation: 2, phase: "paused" } }, true),
    "Paused"
  );
  assert.equal(
    statusLabel({ ...base, desired: "revoked", revocationReason: "expired" }, true),
    "Recording session expired"
  );
  assert.equal(
    statusLabel({ ...base, observed: { generation: 2, phase: "error" } }, true),
    "Capture interrupted"
  );
});
test("connection needs a fresh lease", () => {
  assert.equal(captureConnected(base, at), true);
  assert.equal(captureConnected(base, at + 60000), false);
  assert.equal(captureConnected({ ...base, lastSeenAt: null }, at), false);
});
test("stopped needs an acknowledgement or finished finalization", () => {
  assert.equal(
    captureStopped({ ...base, desired: "stopped", observed: { generation: 2, phase: "stopped" } }),
    true
  );
  assert.equal(captureStopped({ ...base, desired: "stopped", finalization: "complete" }), true);
  assert.equal(captureStopped({ ...base, desired: "stopped" }), false);
});
test("duration advances only while connected and recording", () => {
  assert.equal(recordedDuration(base, at, true), 15000);
  assert.equal(recordedDuration(base, at, false, { grantId: base.grantId, duration: 9000 }), 9000);
  assert.equal(
    recordedDuration(
      { ...base, desired: "paused", observed: { generation: 2, phase: "paused" } },
      at,
      true
    ),
    5000
  );
});
test("source readiness", () => {
  const inv = {
    microphonePermission: "granted",
    systemAudioPermission: "granted",
    microphones: [{ deviceId: "m1" }],
    applications: [],
    computerAudio: { available: true }
  };
  assert.equal(sourceReady({}, inv), true);
  assert.equal(sourceReady({}, { ...inv, microphonePermission: "denied" }), false);
  assert.equal(
    sourceReady(
      { defaultCaptureMode: "microphone-only" },
      { ...inv, systemAudioPermission: "denied" }
    ),
    true
  );
  assert.equal(sourceReady({}, { ...inv, computerAudio: { available: false } }), false);
  assert.equal(sourceReady({}, null), false);
});
test("hints in priority order", () => {
  assert.match(panelHint({ denied: true }), /Recording access is unavailable/);
  assert.equal(
    panelHint({ linkedCount: 0 }),
    "Open Trail Marker and follow its linking instructions."
  );
  assert.equal(panelHint({ linkedCount: 1 }), "Open Trail Marker on your Mac to reconnect.");
  assert.equal(panelHint({ ready: true }), null);
  assert.match(panelHint({ device: { busy: true } }), /recording or finishing/);
  assert.match(
    panelHint({ capture: base, processingReady: false }),
    /Transcription isn’t available/
  );
});
test("failures", () => {
  assert.match(requestFailure({ code: "meeting_capture_busy" }), /still recording/);
  assert.match(requestFailure({ status: 429 }), /wait before retrying/);
  assert.match(requestFailure({ status: 500 }), /unconfirmed/);
  assert.equal(isDefinite({ status: 409 }), true);
  assert.equal(isDefinite({ status: 502 }), false);
});
