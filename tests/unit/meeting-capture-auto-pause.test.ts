import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingCaptureBrowserStatus,
  MeetingCaptureInventory,
  MeetingCaptureState,
  MeetingCaptureStatusInput
} from "@moss/shared";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant
} from "../../packages/meetings/src/capture-repository.js";
import { MeetingCaptureConnectionRepository } from "../../packages/meetings/src/capture-connection-repository.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";
import type { CaptureStoredState } from "../../packages/meetings/src/capture-domain.js";
import {
  captureAcknowledged,
  captureConnected,
  captureStatusLabel
} from "../../packages/meetings/src/web/capture-presentation.js";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
});

function recording() {
  const origin = new Date("2026-10-06T00:00:00Z");
  let clock = new Date(origin.getTime() + 2000);
  const inventory: MeetingCaptureInventory = {
    microphones: [{ deviceId: "mic", sourceId: "mic", label: "Mic" }],
    applications: [],
    computerAudio: { available: false, excludedProcessTreeIds: [] },
    microphonePermission: "granted",
    systemAudioPermission: "unknown"
  };
  const state: CaptureStoredState = {
    gaps: [],
    gapLimitReached: false,
    generation: 1,
    desired: "recording",
    originAt: origin.toISOString(),
    epochs: [
      {
        epoch: 1,
        generation: 1,
        startMs: 0,
        endMs: null,
        selection: { mode: "microphone-only", microphone: { deviceId: "mic", sourceId: "mic" } },
        microphoneLabel: "Mic",
        outputLabel: null,
        modelRoute: "route"
      }
    ],
    stopCutoffMs: null,
    finalizationDeadline: null,
    inventory,
    observed: { generation: 1, phase: "recording" },
    lastSeenAt: clock.toISOString(),
    recordedDurationMs: 1000,
    transcriptRevision: 0
  };
  const credential = `mm1_${owner}.${id}.${"s".repeat(43)}`;
  const grant: CaptureGrant = {
    id,
    meeting_id: id,
    owner_user_id: owner,
    device_id: id,
    device_name: "Mac",
    verifier_hash: "a".repeat(64),
    credential_hash: createHash("sha256").update(credential).digest("hex"),
    session_id: id,
    status: "active",
    created_at: origin,
    expires_at: new Date(origin.getTime() + 7200000),
    state_json: JSON.stringify(state),
    connection_id: id,
    capability_revision: 1
  };
  const dependencies: MeetingCaptureDependencies = {
    dataContext: { withDataContext: async (_actor, run) => run({} as Parameters<typeof run>[0]) },
    resolveBrowser: async () => ({
      actorUserId: owner,
      sessionId: id,
      expiresAt: grant.expires_at
    }),
    resolveCompanion: vi.fn(),
    assertBinding: vi.fn(),
    acquireRecordingBinding: async () => ({ release: async () => {} }),
    scheduleMaintenance: async () => {},
    assertRecordingBinding: async () => ({ expiresAt: grant.expires_at }),
    device: vi.fn(),
    assertModuleAvailable: vi.fn(),
    processingAvailability: async () => ({ ready: true, modelRoute: "route" }),
    transcribe: vi.fn(),
    trustedOrigins: ["https://moss.example"],
    now: () => clock
  };
  vi.spyOn(MeetingCaptureRepository.prototype, "lockMeeting").mockResolvedValue();
  vi.spyOn(MeetingCaptureRepository.prototype, "grant").mockResolvedValue(grant);
  vi.spyOn(MeetingCaptureRepository.prototype, "grants").mockResolvedValue([grant]);
  vi.spyOn(MeetingCaptureRepository.prototype, "reconcileExpiredAudio").mockResolvedValue();
  const save = vi
    .spyOn(MeetingCaptureRepository.prototype, "save")
    .mockImplementation(async (_db, _grant, next) => {
      grant.state_json = JSON.stringify(next);
    });
  vi.spyOn(MeetingCaptureRepository.prototype, "receipt").mockResolvedValue(null);
  vi.spyOn(MeetingCaptureRepository.prototype, "reserve").mockResolvedValue();
  vi.spyOn(MeetingCaptureRepository.prototype, "transcriptHead").mockResolvedValue({
    version: 0,
    cursor: 0,
    transcript_revision: 0,
    stop_cutoff_ms: null
  });
  vi.spyOn(MeetingCaptureConnectionRepository.prototype, "lock").mockResolvedValue();
  vi.spyOn(MeetingCaptureConnectionRepository.prototype, "connection").mockResolvedValue({
    owner_user_id: owner,
    device_id: id,
    connection_id: id,
    device_name: "Mac",
    verifier_hash: grant.verifier_hash,
    capability_revision: 1,
    revision: 1,
    inventory_json: JSON.stringify(inventory),
    last_seen_at: clock,
    expires_at: grant.expires_at
  });
  app = Fastify();
  registerMeetingCaptureRoutes(app, dependencies);
  return {
    grant,
    save,
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
    report: (observed: MeetingCaptureStatusInput["observed"]) =>
      app.inject({
        method: "POST",
        url: "/api/meetings/capture/status",
        headers: { authorization: `Bearer ${credential}` },
        payload: { meetingId: id, grantId: id, inventory, observed }
      }),
    browser: async () => {
      const response = await app.inject({ url: `/api/meetings/records/${id}/capture` });
      expect(response.statusCode).toBe(200);
      return response.json<MeetingCaptureBrowserStatus>();
    }
  };
}

describe("native auto-pause acknowledgement through status and browser APIs", () => {
  it.each([undefined, "meeting_capture_source_unavailable"])(
    "makes an observed native pause resumable while retaining error %s",
    async (errorCode) => {
      const fixture = recording();
      const before = await fixture.browser();
      const native = await fixture.report({ generation: 1, phase: "paused", errorCode });
      expect(native.statusCode).toBe(200);
      const status = await fixture.browser();
      const capture = status.capture!;
      expect(capture).toMatchObject({
        generation: 2,
        desired: "paused",
        observed: { generation: 2, phase: "paused", ...(errorCode ? { errorCode } : {}) },
        epochEndMs: 2000
      });
      expect(native.json<{ capture: MeetingCaptureState }>().capture).toEqual(capture);
      expect(status.revision).not.toBe(before.revision);
      expect(captureAcknowledged(capture)).toBe(true);
      expect(captureConnected(capture, Date.parse(capture.serverTime))).toBe(true);
      expect(status.processingReady).toBe(true);
      expect(captureStatusLabel(capture, true)).toBe("Paused");
    }
  );

  it("keeps acknowledgement and browser revision stable through repeated stale reports", async () => {
    const fixture = recording();
    await fixture.report({ generation: 1, phase: "paused", errorCode: "capture_failed" });
    const paused = await fixture.browser();
    for (const phase of ["paused", "error", "recording", "paused", "error"] as const) {
      const response = await fixture.report({ generation: 1, phase });
      expect(response.statusCode).toBe(200);
      const status = await fixture.browser();
      expect(status.capture!.observed).toEqual({
        generation: 2,
        phase: "paused",
        errorCode: "capture_failed"
      });
      expect(captureAcknowledged(status.capture!)).toBe(true);
      expect(status.revision).toBe(paused.revision);
    }
  });

  it("requires a real current-generation pause after an error-only report", async () => {
    const fixture = recording();
    for (const observed of [
      { generation: 1, phase: "error", errorCode: "capture_failed" },
      { generation: 1, phase: "paused" },
      { generation: 2, phase: "error", errorCode: "capture_failed" }
    ] as const) {
      expect((await fixture.report(observed)).statusCode).toBe(200);
      const { capture } = await fixture.browser();
      expect(capture).toMatchObject({ generation: 2, desired: "paused", observed });
      expect(captureAcknowledged(capture!)).toBe(false);
    }
    await fixture.report({ generation: 2, phase: "paused" });
    expect(captureAcknowledged((await fixture.browser()).capture!)).toBe(true);
  });

  it("rejects future generations without changing the persisted recording", async () => {
    const fixture = recording();
    const before = fixture.grant.state_json;
    const response = await fixture.report({ generation: 2, phase: "paused" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "meeting_capture_conflict" });
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.grant.state_json).toBe(before);
  });

  it("does not acknowledge a browser pause with an unrelated old native pause", async () => {
    const fixture = recording();
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/records/${id}/capture/control`,
      headers: { origin: "https://moss.example" },
      payload: { grantId: id, requestKey: id, expectedGeneration: 1, command: "pause" }
    });
    expect(response.statusCode).toBe(200);
    for (const phase of ["paused", "error", "recording"] as const) {
      expect((await fixture.report({ generation: 1, phase })).statusCode).toBe(200);
      const { capture } = await fixture.browser();
      expect(capture).toMatchObject({ generation: 2, desired: "paused" });
      expect(captureAcknowledged(capture!)).toBe(false);
    }
    await fixture.report({ generation: 2, phase: "paused" });
    expect(captureAcknowledged((await fixture.browser()).capture!)).toBe(true);
  });

  it("preserves lease-expiry interruption until the native pause matches its generation", async () => {
    const fixture = recording();
    fixture.advance(31000);
    expect((await fixture.report({ generation: 1, phase: "paused" })).statusCode).toBe(200);
    const { capture } = await fixture.browser();
    expect(capture).toMatchObject({
      generation: 2,
      desired: "paused",
      observed: { generation: 2, phase: "error", errorCode: "meeting_capture_interrupted" }
    });
    expect(captureAcknowledged(capture!)).toBe(false);
    await fixture.report({ generation: 2, phase: "paused" });
    expect(captureAcknowledged((await fixture.browser()).capture!)).toBe(true);
  });
});
