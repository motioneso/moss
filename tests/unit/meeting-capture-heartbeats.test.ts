import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureInventory } from "@moss/shared";
import { registerMeetingCaptureRoutes } from "../../packages/meetings/src/capture-routes.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant
} from "../../packages/meetings/src/capture-repository.js";
import { MeetingCaptureConnectionRepository } from "../../packages/meetings/src/capture-connection-repository.js";
import type { MeetingCaptureDependencies } from "../../packages/meetings/src/capture-service.js";
import type { CaptureStoredState } from "../../packages/meetings/src/capture-domain.js";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("assembled native heartbeat and conditional browser transport", () => {
  it("holds one browser request through eight actual status reports and returns fresh duration at timeout", async () => {
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
      assertRecordingBinding: async () => ({ expiresAt: grant.expires_at }),
      device: vi.fn(),
      assertModuleAvailable: vi.fn(),
      processingAvailability: async () => ({ ready: true, modelRoute: "route" }),
      transcribe: vi.fn(),
      trustedOrigins: ["https://moss.example"],
      now: () => clock
    };
    const spies = [
      vi.spyOn(MeetingCaptureRepository.prototype, "lockMeeting").mockResolvedValue(),
      vi.spyOn(MeetingCaptureRepository.prototype, "grant").mockResolvedValue(grant),
      vi.spyOn(MeetingCaptureRepository.prototype, "grants").mockResolvedValue([grant]),
      vi.spyOn(MeetingCaptureRepository.prototype, "reconcileExpiredAudio").mockResolvedValue(),
      vi
        .spyOn(MeetingCaptureRepository.prototype, "save")
        .mockImplementation(async (_db, _grant, next) => {
          grant.state_json = JSON.stringify(next);
        }),
      vi
        .spyOn(MeetingCaptureRepository.prototype, "transcriptHead")
        .mockResolvedValue({ version: 0, cursor: 0, transcript_revision: 0, stop_cutoff_ms: null }),
      vi.spyOn(MeetingCaptureConnectionRepository.prototype, "lock").mockResolvedValue(),
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
      })
    ];
    const app = Fastify();
    registerMeetingCaptureRoutes(app, dependencies);
    try {
      const initial = await app.inject({ url: `/api/meetings/records/${id}/capture` });
      expect(initial.statusCode).toBe(200);
      const revision = initial.json().revision as string;
      let completed = false;
      const waiting = app
        .inject({ url: `/api/meetings/records/${id}/capture?revision=${revision}&waitMs=150` })
        .then((result) => {
          completed = true;
          return result;
        });
      await setTimeout(10);
      for (let index = 1; index <= 8; index++) {
        clock = new Date(origin.getTime() + 2000 + index * 1000);
        const native = await app.inject({
          method: "POST",
          url: "/api/meetings/capture/status",
          headers: { authorization: `Bearer ${credential}` },
          payload: {
            meetingId: id,
            grantId: id,
            inventory,
            observed: { generation: 1, phase: "recording" },
            recordedDurationMs: 1000 + index * 1000
          }
        });
        expect(native.statusCode).toBe(200);
        expect(native.json().capture.revision).toBe(revision);
        expect(completed).toBe(false);
      }
      const snapshot = await waiting;
      expect(snapshot.json().capture.recordedDurationMs).toBe(9000);
      expect(snapshot.json().capture.lastSeenAt).toBe(clock.toISOString());
      expect(snapshot.json().revision).toBe(revision);
      // Two reads total: initial snapshot and its bounded keepalive. Eight heartbeats did not restart a browser request.
      expect(spies[2]).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
      for (const spy of spies) spy.mockRestore();
    }
  });
});
