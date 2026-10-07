import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureInventory,
  MeetingCaptureSelection
} from "@moss/shared";
import {
  applyCaptureControl,
  type CaptureStoredState
} from "../../../packages/meetings/src/capture-domain.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant,
  type CaptureReceipt
} from "../../../packages/meetings/src/capture-repository.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../../packages/meetings/src/capture-service.js";
import { MeetingCaptureConnectionRepository } from "../../../packages/meetings/src/capture-connection-repository.js";
import { MeetingTranscriptRepository } from "../../../packages/meetings/src/transcript-repository.js";
import { MeetingPreferencesRepository } from "../../../packages/meetings/src/preferences.js";
export const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const meetingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const grantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const origin = new Date("2026-10-05T00:00:00Z");
export const at = (ms: number) => new Date(origin.getTime() + ms);
export const inventory: MeetingCaptureInventory = {
  microphones: [{ deviceId: "mic-device", sourceId: "mic", label: "Selected microphone" }],
  applications: [{ appProcessTreeId: "selected-app", label: "Selected app" }],
  computerAudio: { available: true, excludedProcessTreeIds: ["moss"] },
  microphonePermission: "granted",
  systemAudioPermission: "granted"
};
export function state(): CaptureStoredState {
  return {
    gaps: [],
    gapLimitReached: false,
    generation: 0,
    desired: "idle",
    originAt: origin.toISOString(),
    epochs: [],
    stopCutoffMs: null,
    finalizationDeadline: null,
    inventory,
    observed: { generation: 0, phase: "idle" },
    lastSeenAt: origin.toISOString()
  };
}
export function command(
  command: MeetingCaptureControlInput["command"],
  generation: number
): MeetingCaptureControlInput {
  return {
    grantId,
    requestKey: randomUUID(),
    expectedGeneration: generation,
    command,
    ...(command === "record"
      ? {
          selection: {
            mode: "microphone-only" as const,
            microphone: { deviceId: "mic-device", sourceId: "mic" }
          }
        }
      : {})
  };
}
export function recording(selection = command("record", 0).selection) {
  const value = state();
  applyCaptureControl(value, { ...command("record", 0), selection }, origin, "route");
  value.observed = { generation: 1, phase: "recording" };
  value.lastSeenAt = at(2000).toISOString();
  return value;
}
export function audio(): MeetingCaptureAudioInput {
  return {
    meetingId,
    grantId,
    requestKey: randomUUID(),
    generation: 1,
    epoch: 1,
    sourceId: "mic",
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    sampleRateHz: 16000,
    pcmBase64: Buffer.alloc(32000).toString("base64")
  };
}
export function fixture(selection?: MeetingCaptureSelection) {
  let active = 0;
  const value = recording(selection);
  const credential = `mm1_${owner}.${grantId}.${"s".repeat(43)}`;
  const grant: CaptureGrant = {
    id: grantId,
    meeting_id: meetingId,
    owner_user_id: owner,
    device_id: deviceId,
    device_name: "Synthetic Mac",
    verifier_hash: "a".repeat(64),
    credential_hash: createHash("sha256").update(credential).digest("hex"),
    session_id: randomUUID(),
    status: "active",
    connection_id: deviceId,
    capability_revision: 1,
    created_at: origin,
    expires_at: at(7200000),
    state_json: JSON.stringify(value)
  };
  const repository = new MeetingCaptureRepository();
  const receipts = new Map<string, CaptureReceipt>();
  vi.spyOn(repository, "reconcileExpiredAudio").mockResolvedValue();
  vi.spyOn(repository, "hasPendingAudio").mockResolvedValue(false);
  vi.spyOn(repository, "lockMeeting").mockResolvedValue();
  vi.spyOn(repository, "grant").mockImplementation(async () => grant);
  vi.spyOn(repository, "save").mockImplementation(async (_db, _grant, next) => {
    grant.state_json = JSON.stringify(next);
    if (next.desired === "revoked") grant.status = "revoked";
  });
  vi.spyOn(repository, "receipt").mockImplementation(async (_db, _id, key, fingerprint) => {
    const row = receipts.get(key);
    if (row && row.fingerprint !== fingerprint) throw Error("conflict");
    return row ?? null;
  });
  vi.spyOn(repository, "reserve").mockImplementation(async (_db, _id, input) => {
    receipts.set(input.requestKey, {
      request_key: input.requestKey,
      kind: input.kind,
      fingerprint: input.fingerprint,
      metadata_json: JSON.stringify(input.metadata),
      result_json: input.result ? JSON.stringify(input.result) : null,
      created_at: at(2000)
    });
  });
  vi.spyOn(repository, "admitAudio").mockImplementation(async (db, _grant, input, fingerprint) =>
    repository.reserve(db, grantId, {
      requestKey: input.requestKey,
      kind: "audio",
      fingerprint,
      metadata: {}
    })
  );
  vi.spyOn(repository, "finish").mockImplementation(async (_db, _id, result) => {
    const receipt = receipts.get(result.requestKey);
    if (receipt) receipt.result_json = JSON.stringify(result);
  });
  vi.spyOn(repository, "transcriptHead").mockResolvedValue({
    version: 0,
    cursor: 0,
    transcript_revision: 0,
    stop_cutoff_ms: null
  });
  const transcript = new MeetingTranscriptRepository();
  vi.spyOn(transcript, "snapshotWithSources").mockResolvedValue(null);
  const ingest = vi.spyOn(transcript, "ingest").mockResolvedValue({
    status: "saved",
    replayed: false,
    receipt: { version: 1, cursor: 1, transcriptRevision: 1, stopCutoffMs: null }
  });
  const deps: MeetingCaptureDependencies = {
    dataContext: {
      withDataContext: async (_actor, run) => {
        active++;
        try {
          return await run({} as Parameters<typeof run>[0]);
        } finally {
          active--;
        }
      }
    },
    resolveBrowser: vi.fn(),
    resolveCompanion: vi.fn(),
    acquireRecordingBinding: async () => ({ release: async () => {} }),
    scheduleMaintenance: async () => {},
    assertRecordingBinding: vi.fn(async () => ({ expiresAt: at(7200000) })),
    assertBinding: vi.fn(async () => {
      expect(active).toBeLessThanOrEqual(1);
    }),
    device: vi.fn(),
    assertModuleAvailable: vi.fn(async () => {
      expect(active).toBe(0);
    }),
    processingAvailability: vi.fn(async () => ({ ready: true, modelRoute: "route" })),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 900, text: "Synthetic transcript" }],
        modelRoute: "route"
      }))
    ),
    trustedOrigins: ["https://moss.example"],
    now: () => at(2000)
  };
  const connections = new MeetingCaptureConnectionRepository();
  vi.spyOn(connections, "lock").mockResolvedValue();
  const connection = {
    owner_user_id: owner,
    device_id: deviceId,
    connection_id: deviceId,
    device_name: "Mac",
    verifier_hash: grant.verifier_hash,
    capability_revision: 1,
    revision: 1,
    inventory_json: JSON.stringify(inventory),
    last_seen_at: at(2000),
    expires_at: at(7200000)
  };
  vi.spyOn(connections, "connection").mockImplementation(async () => connection);
  const preferences = new MeetingPreferencesRepository();
  vi.spyOn(preferences, "get").mockResolvedValue({
    rememberedSource: { deviceId, microphoneId: "mic-device", mode: "microphone-only" },
    defaultCaptureMode: "microphone-only",
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
  vi.spyOn(connections, "lockRequest").mockResolvedValue();
  const service = new MeetingCaptureService(deps, repository, transcript, connections, preferences);
  return {
    deps,
    service,
    preferences,
    connection,
    connections,
    grant,
    ingest,
    repository,
    receipts,
    headers: { authorization: `Bearer ${credential}` },
    browser: { actorUserId: owner, sessionId: grant.session_id!, expiresAt: grant.expires_at }
  };
}
